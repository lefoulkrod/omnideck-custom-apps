"""
app.py — Backend actions for the Conversation Knowledge Base Custom App.

Provides hybrid (semantic + keyword) search across stored LLM conversation history.
"""

import json
import os
import re
import sqlite3
import math
import time
import numpy as np
import requests
from custom_apps import action
from kb_index import KBSearchIndex

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kb.db")
OLLAMA_URL = "http://localhost:11434/api/embed"
OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
EMBED_MODEL = "mxbai-embed-large:latest"
EMBED_DIM = 1024
CONV_DIR = "/var/lib/omnideck/conversations"
DEFAULT_SKILL_MODEL = "huihui_ai/qwen3.5-abliterated:35b"

# Global fast index — lazy-loaded on first search
_search_index = None

def _get_search_index():
    """Get or create the global search index, rebuilding if stale."""
    global _search_index
    if _search_index is None:
        _search_index = KBSearchIndex()
    conn = get_db()
    try:
        _search_index.build_if_needed(conn)
    finally:
        conn.close()
    return _search_index

def _invalidate_search_index():
    """Force index rebuild on next search (call after sync)."""
    global _search_index
    if _search_index is not None:
        _search_index.invalidate()
        _search_index = None


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    _ensure_lessons_table(conn)
    return conn

def _ensure_lessons_table(conn):
    """Create the lessons table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson TEXT NOT NULL,
            category TEXT DEFAULT 'technical_approach',
            context TEXT DEFAULT '',
            importance INTEGER DEFAULT 3,
            active INTEGER DEFAULT 1,
            status TEXT DEFAULT 'draft',
            created_at REAL,
            updated_at REAL
        )
    """)
    # Migrate old active column to status if needed
    try:
        conn.execute("ALTER TABLE lessons ADD COLUMN status TEXT DEFAULT 'draft'")
    except:
        pass
    conn.execute("UPDATE lessons SET status='active' WHERE active = 1 AND (status IS NULL OR status = 'draft')")
    conn.commit()


def embed_query(text):
    """Embed a search query using Ollama."""
    try:
        response = requests.post(OLLAMA_URL, json={
            "model": EMBED_MODEL,
            "input": [text],
        }, timeout=30)
        if response.status_code == 200:
            data = response.json()
            embeddings = data.get("embeddings", [])
            if embeddings:
                return np.array(embeddings[0], dtype=np.float32)
    except Exception as e:
        pass
    return None


def cosine_similarity(query_emb, doc_embs):
    """Compute cosine similarity between query and all document embeddings."""
    # Normalize
    query_norm = query_emb / (np.linalg.norm(query_emb) + 1e-8)
    doc_norms = doc_embs / (np.linalg.norm(doc_embs, axis=1, keepdims=True) + 1e-8)
    # Dot product of normalized vectors = cosine similarity
    return np.dot(doc_norms, query_norm)


@action
def get_stats():
    """Return overview statistics about the knowledge base."""
    conn = get_db()
    try:
        total_convs = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        total_chunks = conn.execute("SELECT COUNT(*) FROM search_embeddings").fetchone()[0]
        total_skills = conn.execute("SELECT COUNT(*) FROM skills").fetchone()[0]
        total_memories = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        total_lessons = conn.execute("SELECT COUNT(*) FROM lessons").fetchone()[0]
        
        date_range = conn.execute(
            "SELECT MIN(date) as min_date, MAX(date) as max_date FROM conversations"
        ).fetchone()
        
        # Top conversations by chunk count (proxy for richness)
        top_convs = conn.execute("""
            SELECT c.title, c.date, c.num_tool_calls, COUNT(se.id) as chunk_count
            FROM conversations c
            LEFT JOIN search_embeddings se ON c.id = se.conversation_id
            GROUP BY c.id
            ORDER BY chunk_count DESC
            LIMIT 5
        """).fetchall()
        
        return {
            "total_conversations": total_convs,
            "total_chunks": total_chunks,
            "total_skills": total_skills,
            "total_memories": total_memories,
            "total_lessons": total_lessons,
            "date_range": {
                "start": date_range["min_date"],
                "end": date_range["max_date"],
            },
            "top_conversations": [
                {
                    "title": r["title"],
                    "date": r["date"],
                    "tool_calls": r["num_tool_calls"],
                    "chunks": r["chunk_count"],
                }
                for r in top_convs
            ],
        }
    finally:
        conn.close()


def tokenize(text, include_bigrams=False):
    """Tokenize text into unigrams (and optionally bigrams)."""
    text = text.lower()
    unigrams = re.findall(r'[a-z0-9]+', text)
    if not include_bigrams or len(unigrams) < 2:
        return unigrams
    bigrams = [f"{unigrams[i]} {unigrams[i+1]}" for i in range(len(unigrams)-1)]
    return unigrams + bigrams

def expand_query(query_tokens, query_emb, all_chunks, top_n=5):
    """Expand query tokens with significant terms from semantically similar chunks.
    
    Finds the top-N most similar chunks and extracts important terms from them,
    adding them to the query token set. This catches synonyms and related concepts.
    """
    if query_emb is None or not all_chunks:
        return query_tokens
    
    # Compute similarity to all chunks
    chunk_texts = [c["chunk_text"] for c in all_chunks]
    try:
        resp = requests.post("http://localhost:11434/api/embed", json={
            "model": EMBED_MODEL, "input": chunk_texts
        }, timeout=60)
        if resp.status_code != 200:
            return query_tokens
        chunk_embs = resp.json().get("embeddings", [])
        if not chunk_embs or len(chunk_embs) != len(all_chunks):
            return query_tokens
        
        chunk_vecs = np.array(chunk_embs, dtype=np.float32)
        query_norm = query_emb / (np.linalg.norm(query_emb) + 1e-8)
        chunk_norms = chunk_vecs / (np.linalg.norm(chunk_vecs, axis=1, keepdims=True) + 1e-8)
        sims = np.dot(chunk_norms, query_norm)
        
        # Get top-N chunk indices
        top_idx = np.argsort(sims)[-top_n:]
        
        # Extract significant terms from those chunks (words 4+ chars, not already in query)
        query_set = set(query_tokens)
        new_terms = []
        for idx in top_idx:
            terms = tokenize(all_chunks[idx]["chunk_text"])
            for t in terms:
                if len(t) >= 4 and t not in query_set and t not in new_terms:
                    new_terms.append(t)
        
        # Limit expansion to avoid diluting the query
        new_terms = new_terms[:10]
        if new_terms:
            expanded = query_tokens + new_terms
            return expanded
    except:
        pass
    
    return query_tokens

def keyword_search(conn, query_tokens, all_chunks):
    """Compute BM25-like keyword scores for each chunk.
    
    Uses unigrams + bigrams for phrase awareness.
    Returns a dict of chunk_id -> keyword_score.
    """
    if not query_tokens:
        return {}
    
    # Tokenize all chunks once (with bigrams)
    chunk_token_lists = []
    for chunk in all_chunks:
        tokens = tokenize(chunk["chunk_text"], include_bigrams=True)
        chunk_token_lists.append(tokens)
    
    # Build document frequency
    df = {}
    for tokens in chunk_token_lists:
        seen = set(tokens)
        for token in seen:
            df[token] = df.get(token, 0) + 1
    
    N = len(all_chunks)
    avgdl = sum(len(t) for t in chunk_token_lists) / max(N, 1)
    
    scores = {}
    k1 = 1.5
    b = 0.75
    
    for i, chunk in enumerate(all_chunks):
        chunk_tokens = chunk_token_lists[i]
        chunk_len = len(chunk_tokens)
        if chunk_len == 0:
            scores[chunk["id"]] = 0
            continue
        
        # Term frequency
        tf = {}
        for token in chunk_tokens:
            tf[token] = tf.get(token, 0) + 1
        
        score = 0.0
        for qt in query_tokens:
            if qt not in tf:
                continue
            n = df.get(qt, 0)
            if n == 0:
                continue
            idf = math.log((N - n + 0.5) / (n + 0.5) + 1)
            term_score = idf * (tf[qt] * (k1 + 1)) / (tf[qt] + k1 * (1 - b + b * chunk_len / max(avgdl, 1)))
            # Bigrams get a small boost (they're more specific)
            if " " in qt:
                term_score *= 1.3
            score += term_score
        
        # Title boost
        title_tokens = set(tokenize(chunk.get("title", "")))
        title_matches = sum(1 for qt in query_tokens if qt in title_tokens)
        if title_matches > 0:
            score *= (1 + 0.5 * title_matches)
        
        scores[chunk["id"]] = score
    
    return scores

@action
def search(query: str, limit: int = 20):
    """Hybrid search (semantic + keyword) across all conversation chunks.
    
    Improvements over v1:
    - Raw cosine scores (no misleading min-max normalization)
    - Phrase-aware BM25 with bigrams
    - Query expansion via semantic similarity (catches synonyms)
    - Adaptive semantic/keyword weight based on query length
    - Conversation-level scoring (weighted average of top chunks)
    """
    if not query or not query.strip():
        return {"results": [], "query": query}
    
    query = query.strip()
    query_tokens = tokenize(query)
    query_emb = embed_query(query)
    
    conn = get_db()
    try:
        # Step 1: Get candidate chunk IDs from the fast index
        candidate_ids = None
        sem_scores_map = {}
        
        if query_emb is not None:
            index = _get_search_index()
            candidate_ids, sem_sims = index.search(query_emb, top_k=300)
            sem_scores_map = dict(zip(candidate_ids, sem_sims))
        
        # Step 2: Load only candidate chunks from SQLite
        if candidate_ids:
            placeholders = ",".join("?" * len(candidate_ids))
            rows = conn.execute(f"""
                SELECT se.id, se.conversation_id, se.chunk_type, se.chunk_index, 
                       se.chunk_text, c.title, c.date
                FROM search_embeddings se
                JOIN conversations c ON se.conversation_id = c.id
                WHERE se.id IN ({placeholders})
                ORDER BY CASE se.id
                    {''.join(f' WHEN ? THEN {i}' for i in range(len(candidate_ids)))}
                END
            """, candidate_ids + candidate_ids).fetchall()
        else:
            rows = conn.execute("""
                SELECT se.id, se.conversation_id, se.chunk_type, se.chunk_index, 
                       se.chunk_text, c.title, c.date
                FROM search_embeddings se
                JOIN conversations c ON se.conversation_id = c.id
            """).fetchall()
        
        if not rows:
            return {"results": [], "query": query, "message": "No indexed conversations found. Run build_index.py first."}
        
        all_chunks = [
            {
                "id": r["id"],
                "conversation_id": r["conversation_id"],
                "chunk_type": r["chunk_type"],
                "chunk_index": r["chunk_index"],
                "chunk_text": r["chunk_text"],
                "title": r["title"],
                "date": r["date"],
            }
            for r in rows
        ]
        
        # Step 3: Query expansion — add related terms from top similar chunks
        # Skip expansion for very short queries (≤2 words) — too much noise
        if query_emb is not None and 3 <= len(query_tokens) <= 5:
            expanded_tokens = expand_query(query_tokens, query_emb, all_chunks, top_n=5)
        else:
            expanded_tokens = query_tokens
        
        # Step 4: Semantic scores — use RAW cosine similarity, no min-max stretch
        # Raw cosine sim is already in a reasonable range (0.2-0.5 for good matches)
        if sem_scores_map:
            sem_scores = {cid: max(0, s) for cid, s in sem_scores_map.items()}  # clamp negatives to 0
        else:
            sem_scores = {}
        
        # Step 5: Keyword scores with bigrams
        kw_scores = keyword_search(conn, expanded_tokens, all_chunks)
        
        # Normalize keyword scores to 0-1
        max_kw = max(kw_scores.values()) if kw_scores else 1
        if max_kw > 0:
            kw_scores = {k: v / max_kw for k, v in kw_scores.items()}
        
        # Step 6: Adaptive weight based on query length
        word_count = len(query_tokens)
        if word_count <= 2:
            # Very short query: keyword slightly favored (exact terms)
            SEMANTIC_WEIGHT = 0.35
            KEYWORD_WEIGHT = 0.65
        elif word_count <= 4:
            # Short query: balanced with slight keyword lean
            SEMANTIC_WEIGHT = 0.4
            KEYWORD_WEIGHT = 0.6
        elif word_count <= 7:
            # Medium query: balanced
            SEMANTIC_WEIGHT = 0.5
            KEYWORD_WEIGHT = 0.5
        else:
            # Long query: semantic dominates (conceptual match)
            SEMANTIC_WEIGHT = 0.65
            KEYWORD_WEIGHT = 0.35
        
        # Step 7: Score each chunk
        chunk_scores = []
        for chunk in all_chunks:
            sem_score = sem_scores.get(chunk["id"], 0)
            kw_score = kw_scores.get(chunk["id"], 0)
            combined = SEMANTIC_WEIGHT * sem_score + KEYWORD_WEIGHT * kw_score
            chunk_scores.append({
                "combined": combined,
                "semantic": sem_score,
                "keyword": kw_score,
                "chunk": chunk,
            })
        
        # Sort by combined score
        chunk_scores.sort(key=lambda x: x["combined"], reverse=True)
        
        # Step 8: Group by conversation with conversation-level scoring
        conv_data = {}  # conv_id -> {chunks: [], scores: [], meta: {}}
        conv_order = []
        
        for cs in chunk_scores:
            chunk = cs["chunk"]
            conv_id = chunk["conversation_id"]
            if conv_id not in conv_data:
                conv_data[conv_id] = {"chunks": [], "scores": [], "meta": {"title": chunk["title"], "date": chunk["date"]}}
                conv_order.append(conv_id)
            conv_data[conv_id]["chunks"].append({
                "score": round(cs["combined"], 4),
                "semantic_score": round(cs["semantic"], 4),
                "keyword_score": round(cs["keyword"], 4),
                "chunk_type": chunk["chunk_type"],
                "chunk_text": chunk["chunk_text"][:500],
                "chunk_index": chunk["chunk_index"],
            })
            conv_data[conv_id]["scores"].append(cs["combined"])
        
        # Score each conversation by weighted average of top-3 chunk scores
        # (not just the single best chunk)
        conv_scored = []
        for conv_id in conv_order:
            d = conv_data[conv_id]
            top_scores = sorted(d["scores"], reverse=True)[:3]
            # Weighted: best gets 0.5, second 0.3, third 0.2
            if len(top_scores) >= 3:
                conv_score = 0.5 * top_scores[0] + 0.3 * top_scores[1] + 0.2 * top_scores[2]
            elif len(top_scores) == 2:
                conv_score = 0.6 * top_scores[0] + 0.4 * top_scores[1]
            else:
                conv_score = top_scores[0]
            conv_scored.append((conv_score, conv_id))
        
        # Sort conversations by their aggregate score
        conv_scored.sort(key=lambda x: x[0], reverse=True)
        
        # Build results
        results = []
        for conv_score, conv_id in conv_scored[:limit]:
            d = conv_data[conv_id]
            meta = d["meta"]
            results.append({
                "conversation_id": conv_id,
                "title": meta["title"],
                "date": meta["date"],
                "score": round(conv_score, 4),
                "match_count": len(d["chunks"]),
                "events_path": os.path.join(CONV_DIR, conv_id, "events.jsonl"),
                "matches": d["chunks"][:5],
            })
        
        return {
            "query": query,
            "total_chunks_searched": len(rows),
            "semantic_weight": SEMANTIC_WEIGHT,
            "keyword_weight": KEYWORD_WEIGHT,
            "query_expanded": len(expanded_tokens) > len(query_tokens),
            "results": results,
        }
    finally:
        conn.close()


@action
def get_conversation(conversation_id: str, max_trajectory_chars: int = 0):
    """Get the compressed trajectory for a conversation.
    
    Args:
        conversation_id: The conversation ID.
        max_trajectory_chars: Max chars for the trajectory. 0 = no limit.
                              Use 5000-10000 for a quick summary, or 0 for full.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,)
        ).fetchone()
        
        if not row:
            return {"error": "Conversation not found"}
        
        trajectory = row["compressed_trajectory"] or ""
        truncated = False
        
        if max_trajectory_chars > 0 and len(trajectory) > max_trajectory_chars:
            # Keep the header + first N chars + last 500 chars (for the conclusion)
            header_end = trajectory.find("\n\n##")
            if header_end == -1:
                header_end = 0
            head = trajectory[:max_trajectory_chars]
            tail = trajectory[-500:]
            trajectory = head + f"\n\n... [truncated, {len(trajectory)} total chars, showing first {max_trajectory_chars}] ...\n\n" + tail
            truncated = True
        
        # Get all chunks for this conversation
        chunks = conn.execute("""
            SELECT chunk_type, chunk_index, chunk_text
            FROM search_embeddings
            WHERE conversation_id = ?
            ORDER BY chunk_index
        """, (conversation_id,)).fetchall()
        
        return {
            "id": row["id"],
            "title": row["title"],
            "date": row["date"],
            "num_events": row["num_events"],
            "num_tool_calls": row["num_tool_calls"],
            "num_user_msgs": row["num_user_msgs"],
            "est_tokens": row["est_tokens"],
            "trajectory": trajectory,
            "trajectory_chars": len(row["compressed_trajectory"] or ""),
            "trajectory_truncated": truncated,
            "events_path": os.path.join(CONV_DIR, conversation_id, "events.jsonl"),
            "chunks": [
                {
                    "type": c["chunk_type"],
                    "index": c["chunk_index"],
                    "text": c["chunk_text"],
                }
                for c in chunks
            ],
        }
    finally:
        conn.close()


@action
def list_conversations(page: int = 1, per_page: int = 20):
    """List all conversations with pagination."""
    conn = get_db()
    try:
        offset = (page - 1) * per_page
        
        total = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        
        rows = conn.execute("""
            SELECT c.id, c.title, c.date, c.num_events, c.num_tool_calls, 
                   c.num_user_msgs, c.est_tokens,
                   (SELECT COUNT(*) FROM search_embeddings WHERE conversation_id = c.id) as chunk_count,
                   (SELECT COUNT(*) FROM skills WHERE conversation_id = c.id) as skill_count
            FROM conversations c
            ORDER BY c.date DESC
            LIMIT ? OFFSET ?
        """, (per_page, offset)).fetchall()
        
        return {
            "conversations": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "date": r["date"],
                    "num_events": r["num_events"],
                    "num_tool_calls": r["num_tool_calls"],
                    "num_user_msgs": r["num_user_msgs"],
                    "est_tokens": r["est_tokens"],
                    "chunk_count": r["chunk_count"],
                    "skill_count": r["skill_count"],
                }
                for r in rows
            ],
            "page": page,
            "per_page": per_page,
            "total": total,
            "total_pages": (total + per_page - 1) // per_page,
        }
    finally:
        conn.close()


# ─── Lessons ─────────────────────────────────────────────────────

@action
def list_lessons(status_filter: str = ""):
    """List lessons, optionally filtered by status (draft, active, rejected, archived)."""
    conn = get_db()
    try:
        if status_filter:
            rows = conn.execute("SELECT * FROM lessons WHERE status = ? ORDER BY importance DESC, created_at DESC", (status_filter,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM lessons ORDER BY importance DESC, created_at DESC").fetchall()
        return {
            "lessons": [{"id": r["id"], "lesson": r["lesson"], "category": r["category"], "context": r["context"], "importance": r["importance"], "status": r["status"] or "draft", "created_at": r["created_at"], "updated_at": r["updated_at"]} for r in rows],
            "count": len(rows),
        }
    finally:
        conn.close()

@action
def get_lesson(lesson_id: int):
    """Get a single lesson by ID."""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
        if not row:
            return {"error": "Lesson not found"}
        return {"id": row["id"], "lesson": row["lesson"], "category": row["category"], "context": row["context"], "importance": row["importance"], "status": row["status"] or "draft", "created_at": row["created_at"], "updated_at": row["updated_at"]}
    finally:
        conn.close()

@action
def update_lesson(lesson_id: int, lesson: str = "", category: str = "", context: str = "", importance: int = 0, status: str = ""):
    """Update a lesson's fields. Only supplied fields are changed."""
    conn = get_db()
    try:
        updates = []
        params = []
        if lesson:
            updates.append("lesson = ?")
            params.append(lesson)
        if category:
            updates.append("category = ?")
            params.append(category)
        if context:
            updates.append("context = ?")
            params.append(context)
        if importance > 0:
            updates.append("importance = ?")
            params.append(importance)
        if status:
            updates.append("status = ?")
            params.append(status)
            updates.append("active = ?")
            params.append(1 if status == "active" else 0)
        if not updates:
            return {"error": "No fields to update"}
        updates.append("updated_at = ?")
        params.append(time.time())
        params.append(lesson_id)
        conn.execute(f"UPDATE lessons SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
        return {"success": True, "message": "Lesson updated"}
    finally:
        conn.close()

@action
def delete_lesson(lesson_id: int):
    """Delete a lesson by ID."""
    conn = get_db()
    try:
        conn.execute("DELETE FROM lessons WHERE id = ?", (lesson_id,))
        conn.commit()
        return {"success": True, "message": "Lesson deleted"}
    finally:
        conn.close()

@action
def import_lessons(lessons_json: str):
    """Import lessons from a JSON string."""
    conn = get_db()
    try:
        data = json.loads(lessons_json)
        if isinstance(data, dict) and "lessons" in data:
            data = data["lessons"]
        imported = 0
        now = time.time()
        for item in data:
            if isinstance(item, dict) and item.get("lesson"):
                conn.execute("INSERT INTO lessons (lesson, category, context, importance, active, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)", (item["lesson"], item.get("category", "technical_approach"), item.get("context", ""), item.get("importance", 3), now, now))
                imported += 1
        conn.commit()
        return {"success": True, "imported": imported, "message": f"Imported {imported} lessons"}
    except json.JSONDecodeError:
        return {"error": "Invalid JSON"}
    finally:
        conn.close()

@action
def get_lessons_stats():
    """Get lesson statistics."""
    conn = get_db()
    try:
        total = conn.execute("SELECT COUNT(*) FROM lessons").fetchone()[0]
        by_status = {}
        for r in conn.execute("SELECT status, COUNT(*) as cnt FROM lessons GROUP BY status").fetchall():
            by_status[r["status"] or "draft"] = r["cnt"]
        by_category = {}
        for r in conn.execute("SELECT category, COUNT(*) as cnt FROM lessons WHERE status = 'active' GROUP BY category").fetchall():
            by_category[r["category"]] = r["cnt"]
        return {"total": total, "by_status": by_status, "by_category": by_category}
    finally:
        conn.close()

# ─── Lesson Extraction ──────────────────────────────────────────

SELF_CORRECTION_SIGNALS = [
    "didn't work", "doesn't work",
    "let me try a different", "let me try another",
    "unfortunately", "wasn't able", "was not able",
    "the issue is", "the problem is",
    "i should have",
    "that was wrong", "that was incorrect",
    "better to use", "better approach is",
    "instead of using", "instead of trying",
]

EXTRACT_BATCH_PROMPT = """You are analyzing {n} self-corrections from an AI assistant. Each one shows the assistant recognizing a mistake and trying a different approach. Extract the most important GENERALIZABLE lessons.

CRITICAL RULES for a good lesson:
- Name the SPECIFIC TOOL that failed and the SPECIFIC TOOL that worked instead
- Explain WHY it failed (the root cause)
- Be actionable: "When doing X, don't use Y because Z. Use W instead."
- The lesson should be specific enough that the assistant could follow it without guessing

BAD examples (too vague, REJECT these):
❌ "When external resources are blocked, use alternatives" → what alternatives?
❌ "Manage the environment explicitly" → how?
❌ "Follow best practices" → which ones?

GOOD examples (specific, actionable):
✅ "When editing files with special characters (apostrophes, Unicode), don't use sed because it breaks on special chars. Use Python with string.replace() or write_file instead."
✅ "When CSP blocks external CDN stylesheets, don't link to CDN URLs. Download the file and serve it locally from the same origin."
✅ "When running long subprocesses, don't let them block the main thread. Background with '&' and redirect stdout/stderr to a log file."

{negative_examples}

Here are the {n} self-corrections:

{corrections}

Output a JSON array of the best lessons found in THIS batch. Each lesson MUST follow the specific format above. If no good lessons are found, output [].

[
  {{
    "lesson": "When doing X with tool Y, don't do Z because [reason]. Do W instead.",
    "category": "technical_approach|workflow|debugging|tool_usage|environment",
    "context": "when this applies (e.g., 'when editing files', 'when running subprocesses')",
    "importance": 1-5
  }}
]

BE AGGRESSIVE about rejecting vague lessons. Only include lessons that name specific tools and specific fixes."""

EXTRACT_CONSOLIDATE_PROMPT = """Below are {n} lessons extracted from different batches. Consolidate them into the 10-15 most important, non-redundant lessons.

CRITICAL: Each lesson MUST name the specific tool that failed, explain why, and say what to use instead. Reject vague lessons.

{negative_examples}

Lessons:
{lessons}

Output a JSON array of the consolidated lessons. Merge similar ones but keep the most specific version. Target 10-15.

[
  {{
    "lesson": "When doing X with tool Y, don't do Z because [reason]. Do W instead.",
    "category": "technical_approach|workflow|debugging|tool_usage|environment",
    "context": "when this applies",
    "importance": 1-5
  }}
]"""


def _ensure_lessons_extracted_column(conn):
    try:
        conn.execute("ALTER TABLE conversations ADD COLUMN lessons_extracted_at REAL")
        conn.commit()
    except:
        pass


def _scan_self_corrections(conv_ids):
    results = []
    for conv_id in conv_ids:
        events_path = os.path.join(CONV_DIR, conv_id, "events.jsonl")
        if not os.path.exists(events_path):
            continue
        with open(events_path) as f:
            events = [json.loads(line) for line in f]
        for i, e in enumerate(events):
            if e.get("type") != "iteration":
                continue
            thinking = (e.get("thinking") or "")
            thinking_lower = thinking.lower()
            matched = [s for s in SELF_CORRECTION_SIGNALS if s in thinking_lower]
            if not matched:
                continue
            prev_result = ""
            for j in range(max(0, i - 3), i):
                if events[j].get("type") == "tool_result":
                    prev_result = (events[j].get("content") or "")[:200]
                    break
            next_action = ""
            for j in range(i + 1, min(len(events), i + 3)):
                if events[j].get("type") == "iteration":
                    tcs = events[j].get("tool_calls") or []
                    if tcs:
                        tc = tcs[0]
                        args = tc.get("arguments", {})
                        compact = {}
                        for k in ["cmd", "path", "url", "name", "pattern"]:
                            if k in args:
                                compact[k] = str(args[k])[:80]
                        next_action = f"{tc.get('name')}({json.dumps(compact)})"
                    break
            results.append({"thinking": thinking[:250], "prev_result": prev_result, "next_action": next_action})
    return results


def _format_batch(corrections, start, count):
    lines = []
    for i, c in enumerate(corrections[start:start + count]):
        idx = start + i + 1
        lines.append(f"--- {idx} ---")
        lines.append(f"Thinking: {c['thinking']}")
        if c['prev_result']:
            lines.append(f"Failed: {c['prev_result'][:150]}")
        if c['next_action']:
            lines.append(f"Fixed: {c['next_action'][:120]}")
        lines.append("")
    return "\n".join(lines)


def _call_llm(prompt, timeout=120):
    try:
        resp = requests.post(OLLAMA_CHAT_URL, json={
            "model": "deepseek-v4-flash:cloud",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"temperature": 0.1, "num_ctx": 16384},
        }, timeout=timeout)
        if resp.status_code != 200:
            return None
        content = resp.json().get("message", {}).get("content", "")
        m = re.search(r'\[.*\]', content, re.DOTALL)
        if m:
            return json.loads(m.group())
    except:
        pass
    return None


def _tokenize(text):
    return set(re.findall(r'[a-z0-9]+', text.lower()))


def _is_duplicate_lesson(new_text, existing_texts, threshold=0.45):
    new_tokens = _tokenize(new_text)
    if not new_tokens:
        return False
    for existing in existing_texts:
        existing_tokens = _tokenize(existing)
        if not existing_tokens:
            continue
        intersection = new_tokens & existing_tokens
        union = new_tokens | existing_tokens
        if len(intersection) / len(union) >= threshold:
            return True
    return False


@action
def extract_lessons(max_seconds: int = 100):
    """Extract lessons from new/modified conversations using self-correction analysis."""
    conn = get_db()
    _ensure_lessons_extracted_column(conn)
    try:
        now = time.time()
        to_process = []
        for d in sorted(os.listdir(CONV_DIR)):
            if d.startswith("_") or d == "routines":
                continue
            events_path = os.path.join(CONV_DIR, d, "events.jsonl")
            if not os.path.exists(events_path):
                continue
            row = conn.execute("SELECT lessons_extracted_at FROM conversations WHERE id = ?", (d,)).fetchone()
            file_mtime = os.path.getmtime(events_path)
            if not row or row["lessons_extracted_at"] is None or file_mtime > row["lessons_extracted_at"]:
                to_process.append(d)
        if not to_process:
            return {"extracted": 0, "message": "No new conversations to process"}
        start_time = time.time()
        corrections = _scan_self_corrections(to_process)
        if not corrections:
            for conv_id in to_process:
                conn.execute("UPDATE conversations SET lessons_extracted_at = ? WHERE id = ?", (now, conv_id))
            conn.commit()
            return {"extracted": 0, "message": f"Scanned {len(to_process)} conversations, no self-corrections found"}
        rejected = conn.execute("SELECT lesson FROM lessons WHERE status IN ('rejected', 'archived') ORDER BY updated_at DESC LIMIT 20").fetchall()
        negative_examples = ""
        if rejected:
            neg_texts = "\n".join(f"- {r['lesson'][:200]}" for r in rejected)
            negative_examples = f"\nThese lessons were previously generated but REJECTED by the user. Do NOT generate similar lessons:\n{neg_texts}\n"
        batch_size = 100
        all_lessons = []
        for batch_start in range(0, len(corrections), batch_size):
            if time.time() - start_time > max_seconds:
                break
            batch_text = _format_batch(corrections, batch_start, batch_size)
            n = min(batch_size, len(corrections) - batch_start)
            prompt = EXTRACT_BATCH_PROMPT.replace("{n}", str(n)).replace("{corrections}", batch_text).replace("{negative_examples}", negative_examples)
            result = _call_llm(prompt, timeout=min(60, max_seconds))
            if result:
                all_lessons.extend(result)
            time.sleep(0.5)
        if len(all_lessons) > 15 and time.time() - start_time < max_seconds:
            lessons_text = "\n".join(f"{i+1}. [{l.get('category', '?')}] {l.get('lesson', '')}" for i, l in enumerate(all_lessons))
            prompt = EXTRACT_CONSOLIDATE_PROMPT.replace("{n}", str(len(all_lessons))).replace("{lessons}", lessons_text).replace("{negative_examples}", negative_examples)
            result = _call_llm(prompt, timeout=min(60, max_seconds))
            if result:
                all_lessons = result
        active_lessons = [r["lesson"] for r in conn.execute("SELECT lesson FROM lessons WHERE status = 'active'").fetchall()]
        imported = 0
        for item in all_lessons:
            if isinstance(item, dict) and item.get("lesson"):
                if _is_duplicate_lesson(item["lesson"], active_lessons):
                    continue
                conn.execute("INSERT INTO lessons (lesson, category, context, importance, active, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)", (item["lesson"], item.get("category", "technical_approach"), item.get("context", ""), item.get("importance", 3), now, now))
                imported += 1
        for conv_id in to_process:
            conn.execute("UPDATE conversations SET lessons_extracted_at = ? WHERE id = ?", (now, conv_id))
        conn.commit()
        elapsed = time.time() - start_time
        return {"extracted": imported, "total_found": len(all_lessons), "conversations_scanned": len(to_process), "self_corrections_found": len(corrections), "elapsed": round(elapsed, 1), "message": f"Extracted {imported} new lessons from {len(to_process)} conversations in {elapsed:.1f}s. Review them in the Lessons tab."}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ─── Sync: keep the index up to date ─────────────────────────────

def _load_events(conv_id):
    """Load all events from a conversation's events.jsonl."""
    events_path = os.path.join(CONV_DIR, conv_id, "events.jsonl")
    events = []
    with open(events_path) as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except:
                pass
    return events

def _load_title(conv_id):
    """Load conversation title from metadata.json."""
    meta_path = os.path.join(CONV_DIR, conv_id, "metadata.json")
    if os.path.exists(meta_path):
        try:
            return json.load(open(meta_path)).get("title", "(no title)")
        except:
            pass
    return "(no title)"

def _get_date(events):
    for evt in events:
        ts = evt.get("timestamp", "")
        if ts:
            return ts[:10]
    return "unknown"

def _compress_result(content, max_chars=300):
    if not content:
        return "(empty result)"
    content_lower = content.lower()
    status_parts = []
    import re as _re
    m = _re.search(r"'exit_code':\s*(\d+)", content)
    if m:
        code = int(m.group(1))
        status_parts.append(f"exit={code}({'success' if code == 0 else 'FAILED'})")
    if any(w in content_lower for w in ["traceback", "exception", "permission denied", "no such file", "does not exist"]):
        status_parts.append("ERROR")
    if "not found" in content_lower or "no results" in content_lower or "'matches': []" in content_lower:
        status_parts.append("NO_RESULTS")
    if "blocked" in content_lower or "403" in content_lower or "404" in content_lower:
        status_parts.append("BLOCKED")
    if "'success': true" in content_lower or "'success': True" in content_lower:
        status_parts.append("success=True")
    if "'success': false" in content_lower or "'success': False" in content_lower:
        status_parts.append("success=False")
    status = ", ".join(status_parts) if status_parts else "ok"
    if len(content) <= max_chars:
        preview = content.strip()
    else:
        preview = content[:200].strip() + " ...[truncated]... " + content[-100:].strip()
    return f"[{status}] {preview}"

def _build_trajectory(events, title):
    """Build compressed trajectory text."""
    lines = [f"# Conversation: {title}", f"# Total events: {len(events)}", ""]
    step_num = 0
    for evt in events:
        etype = evt.get("type")
        if etype == "user_message":
            lines.append(f"\n## USER MESSAGE:")
            lines.append((evt.get("content") or "")[:2000])
            lines.append("")
        elif etype == "iteration":
            step_num += 1
            thinking = evt.get("thinking") or ""
            content = evt.get("content") or ""
            lines.append(f"\n### Step {step_num}:")
            if thinking:
                lines.append(f"THINKING: {thinking[:1000]}")
            for tc in (evt.get("tool_calls") or []):
                tool_name = tc.get("name", "?")
                args = tc.get("arguments", {})
                key_args = {}
                for k in ["cmd", "path", "url", "query", "pattern", "name", "selector", "code", "instructions"]:
                    if k in args:
                        key_args[k] = str(args[k])[:150]
                lines.append(f"  TOOL_CALL: {tool_name}({json.dumps(key_args) if key_args else '{}'})")
            if content:
                lines.append(f"RESPONSE: {content[:2000]}")
        elif etype == "tool_result":
            lines.append(f"  RESULT({evt.get('tool_name', '?')}): {_compress_result(evt.get('content') or '')}")
    return "\n".join(lines)

def _extract_chunks(events, title):
    """Extract searchable text chunks from a conversation."""
    chunks = []
    user_msgs = [e for e in events if e.get("type") == "user_message"]
    if user_msgs:
        summary = f"Conversation: {title}\nFirst message: {(user_msgs[0].get('content') or '')[:500]}"
        chunks.append(("summary", 0, summary))
    msg_idx = 0
    for evt in events:
        if evt.get("type") == "user_message":
            content = (evt.get("content") or "").strip()
            if content and len(content) > 10:
                chunks.append(("user_message", msg_idx, content[:1000]))
                msg_idx += 1
    resp_idx = 0
    for evt in events:
        if evt.get("type") == "iteration":
            content = (evt.get("content") or "").strip()
            if content and len(content) > 50:
                chunks.append(("agent_response", resp_idx, content[:1500]))
                resp_idx += 1
    return chunks

def _embed_texts(texts, batch_size=20):
    """Generate embeddings for a list of texts using Ollama."""
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        try:
            response = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": batch}, timeout=60)
            if response.status_code == 200:
                for emb in response.json().get("embeddings", []):
                    all_embeddings.append(np.array(emb, dtype=np.float32))
            else:
                for _ in batch:
                    all_embeddings.append(np.zeros(EMBED_DIM, dtype=np.float32))
        except:
            for _ in batch:
                all_embeddings.append(np.zeros(EMBED_DIM, dtype=np.float32))
    return all_embeddings

@action
def get_sync_status():
    """Check how many conversations are indexed vs on disk, and if any need updating."""
    conn = get_db()
    try:
        # Ensure indexed_at column exists
        try:
            conn.execute("ALTER TABLE conversations ADD COLUMN indexed_at REAL")
            conn.commit()
        except:
            pass
        
        # Count indexed conversations
        indexed = conn.execute("SELECT COUNT(*) FROM conversations WHERE processed_search = 1").fetchone()[0]
        
        # Scan disk for conversations with events.jsonl
        on_disk = 0
        new_convs = []
        updated_convs = []
        renamed_convs = []
        
        for d in sorted(os.listdir(CONV_DIR)):
            if d.startswith("_") or d == "routines":
                continue
            events_path = os.path.join(CONV_DIR, d, "events.jsonl")
            if not os.path.exists(events_path):
                continue
            on_disk += 1
            
            # Check if in DB
            row = conn.execute("SELECT id, indexed_at, title FROM conversations WHERE id = ?", (d,)).fetchone()
            file_mtime = os.path.getmtime(events_path)
            
            if not row:
                new_convs.append(d)
            elif row["indexed_at"] and file_mtime > row["indexed_at"]:
                updated_convs.append(d)
            elif row:
                # Check for rename (metadata.json title != DB title)
                meta_path = os.path.join(CONV_DIR, d, "metadata.json")
                if os.path.exists(meta_path):
                    try:
                        disk_title = json.load(open(meta_path)).get("title", "")
                        if disk_title and row["title"] != disk_title:
                            renamed_convs.append(d)
                    except:
                        pass
        
        # Check for deleted conversations (in DB but not on disk)
        db_ids = set(r[0] for r in conn.execute("SELECT id FROM conversations").fetchall())
        disk_ids = set()
        for d in os.listdir(CONV_DIR):
            if d.startswith("_") or d == "routines":
                continue
            if os.path.exists(os.path.join(CONV_DIR, d, "events.jsonl")):
                disk_ids.add(d)
        deleted_convs = db_ids - disk_ids
        
        return {
            "indexed": indexed,
            "on_disk": on_disk,
            "new_conversations": len(new_convs),
            "updated_conversations": len(updated_convs),
            "renamed_conversations": len(renamed_convs),
            "deleted_conversations": len(deleted_convs),
            "needs_sync": len(new_convs) + len(updated_convs) + len(renamed_convs) + len(deleted_convs) > 0,
        }
    finally:
        conn.close()

@action
def sync(max_seconds: int = 100):
    """Sync the index with new, updated, renamed, and deleted conversations.
    
    Scans for conversations not yet indexed (or with updated events.jsonl),
    processes them, and returns stats. Also cleans up deleted conversations
    and updates renamed ones. Designed to fit within the 120s action timeout.
    """
    conn = get_db()
    try:
        # Ensure indexed_at column exists
        try:
            conn.execute("ALTER TABLE conversations ADD COLUMN indexed_at REAL")
            conn.commit()
        except:
            pass  # Column already exists
        
        # 1. Clean up deleted conversations (in DB but not on disk)
        db_ids = set(r[0] for r in conn.execute("SELECT id FROM conversations").fetchall())
        disk_ids = set()
        for d in os.listdir(CONV_DIR):
            if d.startswith("_") or d == "routines":
                continue
            if os.path.exists(os.path.join(CONV_DIR, d, "events.jsonl")):
                disk_ids.add(d)
        deleted_ids = db_ids - disk_ids
        
        deleted_count = 0
        for conv_id in deleted_ids:
            conn.execute("DELETE FROM search_embeddings WHERE conversation_id = ?", (conv_id,))
            conn.execute("DELETE FROM skills WHERE conversation_id = ?", (conv_id,))
            conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
            deleted_count += 1
        
        if deleted_count > 0:
            conn.commit()
        
        # 2. Update renamed conversations (title changed on disk)
        renamed_count = 0
        for conv_id in (db_ids & disk_ids):
            row = conn.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if not row:
                continue
            meta_path = os.path.join(CONV_DIR, conv_id, "metadata.json")
            if os.path.exists(meta_path):
                try:
                    disk_title = json.load(open(meta_path)).get("title", "")
                    if disk_title and row["title"] != disk_title:
                        conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (disk_title, conv_id))
                        renamed_count += 1
                except:
                    pass
        
        if renamed_count > 0:
            conn.commit()
        
        # 3. Find conversations that need processing (new or updated)
        to_process = []
        for d in sorted(os.listdir(CONV_DIR)):
            if d.startswith("_") or d == "routines":
                continue
            events_path = os.path.join(CONV_DIR, d, "events.jsonl")
            if not os.path.exists(events_path):
                continue
            
            row = conn.execute("SELECT id, indexed_at FROM conversations WHERE id = ?", (d,)).fetchone()
            file_mtime = os.path.getmtime(events_path)
            
            if not row or (row["indexed_at"] and file_mtime > row["indexed_at"]) or (row and not row["indexed_at"]):
                to_process.append(d)
        
        if not to_process and deleted_count == 0 and renamed_count == 0:
            return {"processed": 0, "message": "Index is up to date", "new_conversations": 0, "updated_conversations": 0, "deleted": 0, "renamed": 0}
        
        # Check Ollama is available
        try:
            requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": "test"}, timeout=10)
        except:
            return {"error": "Cannot reach Ollama for embeddings. Is it running?"}
        
        start_time = time.time()
        processed = 0
        is_new = 0
        is_updated = 0
        
        for conv_id in to_process:
            # Check time budget
            if time.time() - start_time > max_seconds:
                break
            
            try:
                events = _load_events(conv_id)
                if not events:
                    continue
                
                title = _load_title(conv_id)
                date = _get_date(events)
                num_events = len(events)
                num_tool_calls = sum(len(e.get("tool_calls") or []) for e in events if e.get("type") == "iteration")
                num_user_msgs = sum(1 for e in events if e.get("type") == "user_message")
                
                trajectory = _build_trajectory(events, title)
                est_tokens = len(trajectory) // 4
                
                # Check if this is new or an update
                existing = conn.execute("SELECT id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                if existing:
                    is_updated += 1
                else:
                    is_new += 1
                
                # Store/update conversation
                conn.execute("""
                    INSERT INTO conversations (id, title, date, num_events, num_tool_calls, num_user_msgs,
                         compressed_trajectory, est_tokens, processed_search, indexed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title, date=excluded.date, num_events=excluded.num_events,
                        num_tool_calls=excluded.num_tool_calls, num_user_msgs=excluded.num_user_msgs,
                        compressed_trajectory=excluded.compressed_trajectory, est_tokens=excluded.est_tokens,
                        processed_search=1, indexed_at=excluded.indexed_at
                """, (conv_id, title, date, num_events, num_tool_calls, num_user_msgs,
                      trajectory, est_tokens, time.time()))
                
                # Extract and embed chunks
                chunks = _extract_chunks(events, title)
                if chunks:
                    chunk_texts = [c[2] for c in chunks]
                    embeddings = _embed_texts(chunk_texts)
                    
                    # Clear old embeddings
                    conn.execute("DELETE FROM search_embeddings WHERE conversation_id = ?", (conv_id,))
                    
                    for (chunk_type, chunk_index, chunk_text), emb in zip(chunks, embeddings):
                        conn.execute("""
                            INSERT INTO search_embeddings (conversation_id, chunk_type, chunk_index, chunk_text, embedding)
                            VALUES (?, ?, ?, ?, ?)
                        """, (conv_id, chunk_type, chunk_index, chunk_text, emb.astype(np.float32).tobytes()))
                
                conn.commit()
                processed += 1
                
            except Exception as e:
                conn.rollback()
                continue
        
        elapsed = time.time() - start_time
        
        parts = []
        if processed > 0:
            parts.append(f"processed {processed} ({is_new} new, {is_updated} updated)")
        if deleted_count > 0:
            parts.append(f"removed {deleted_count} deleted")
        if renamed_count > 0:
            parts.append(f"updated {renamed_count} renamed")
        if not parts:
            parts.append("up to date")
        
        # Invalidate the fast index if anything changed
        if processed > 0 or deleted_count > 0 or renamed_count > 0:
            _invalidate_search_index()
        
        return {
            "processed": processed,
            "new_conversations": is_new,
            "updated_conversations": is_updated,
            "deleted": deleted_count,
            "renamed": renamed_count,
            "remaining": len(to_process) - processed,
            "elapsed": round(elapsed, 1),
            "message": f"{', '.join(parts)}" + (f" in {elapsed:.1f}s" if elapsed > 0 else ""),
        }
    finally:
        conn.close()


# ─── Skill Extraction ───────────────────────────────────────────

SKILL_EXTRACTION_PROMPT = """You are a skill extractor. You analyze a conversation between a user and an AI agent that was working together to solve a problem. Your job is to extract a GENERALIZED "happy path" — a reusable playbook abstracted away from the specific details of this one conversation — OR reject the conversation if it's not worth extracting.

Here is the conversation trajectory. Each step shows the agent's thinking, the tool it called, and the result:

<conversation>
{trajectory}
</conversation>

First, decide if this conversation is worth extracting a skill from. A conversation is NOT worth extracting if:
- It's a test, greeting, or trivial one-off ("hello", "test", "what is 2+2")
- The task was abandoned or never completed
- The "happy path" would just be common sense (e.g., "search Google, read results, summarize")
- There are fewer than 3 non-trivial steps in the solution
- The task is so specific it can't be generalized (e.g., "download this exact image")
- The conversation is just navigating to a website and clicking things — this is not a skill
- The conversation is a simple web search with no non-obvious steps or workarounds
- The "happy path" would be something anyone could figure out in 30 seconds

BE AGGRESSIVE ABOUT REJECTING. If you have to think hard about whether a conversation is worth extracting, it probably isn't. At least 50% of conversations should be rejected. When in doubt, REJECT.

If the conversation is NOT worth extracting, output exactly:
```
## REJECTED
Reason: [one sentence explaining why]
```

If the conversation IS worth extracting, output in this exact format:

## SKILL: [concise, generalized title — NOT specific to this instance]

## PROBLEM
[1-2 sentence description of the general class of problem, not the specific instance]

## TASK_TYPE
[One word: research, build, configure, qa, debug, or other]

## DIFFICULTY
[One word: simple, medium, or complex]

## REUSABILITY
[A single number 1-5. Be strict. Use these criteria:]

  1 = TRIVIAL: Test messages, greetings, "what is X" lookups, simple file creation, single tool calls with no problem-solving. If someone could figure this out in 10 seconds without help, it's a 1.

  2 = LOW: Straightforward tasks with obvious steps (send one email, search one thing, create one file). No failures, no decisions, no non-obvious steps. The "happy path" would just be common sense.

  3 = MODERATE: Multi-step task with some non-obvious elements. Has a clear workflow that someone might benefit from following, but isn't complex.

  4 = HIGH: Complex multi-step workflow with real problem-solving. Failed approaches were tried and corrected. The happy path contains non-obvious steps, specific parameters, or workarounds that would save someone significant time.

  5 = VERY HIGH: Expert-level workflow with many steps, multiple failure modes, and hard-won knowledge. The pitfalls alone would save hours.

  Most conversations will be 1-2. Be honest. If in doubt, rate lower.

## HAPPY PATH
[Numbered list of GENERALIZED steps. Abstract away specific values into placeholders. This should be reusable for ANY similar task, not just the exact one in this conversation.]

  Use [brackets] for placeholders like [topic], [url], [recipient], [filename], etc.
  Only include steps that actually worked or were necessary. Skip failed attempts.
  Be specific about TOOL NAMES and APPROACH, but generalize the DATA.

## PITFALLS
[Generalized lessons — what approaches don't work for this class of problem. Be specific about what went wrong and why, but abstract away specifics.]

## NOTES
[Any other useful observations. If the task was abandoned or not completed, say so here.]

---

Here are examples of GOOD and BAD skill extractions:

### EXAMPLE: GOOD SKILL (REUSABILITY 4)

Conversation: User wanted to build a multi-arch Docker image that works on both AMD64 and ARM64, including browser automation. Multiple approaches failed before finding the right one.

## SKILL: Multi-Arch Docker Builds with ARM64 Browser Support

## PROBLEM
A Docker image built only for amd64 needs to run on ARM64 (Apple Silicon, Raspberry Pi) while preserving the existing amd64 build, including browser automation.

## TASK_TYPE
build

## DIFFICULTY
complex

## REUSABILITY
4

## HAPPY PATH
1. Add `ARG TARGETARCH` to the Dockerfile and wrap arch-sensitive steps in `case "${TARGETARCH}"` blocks with a `*)` fall-through that fails loudly.
2. For the browser on ARM64: Google Chrome is not available, so use Playwright's bundled Chromium: `pip install playwright && python -m playwright install --with-deps chromium`.
3. In browser code, make `channel="chrome"` conditional on `platform.machine() == "x86_64"`; on ARM64 omit the channel so Playwright falls back to bundled Chromium.
4. Override User-Agent and Client Hints on ARM64 using CDP `Network.setUserAgentOverride` with a real Chrome metadata object to avoid bot detection.
5. Update CI to build natively on both amd64 and arm64 runners using a matrix strategy, with per-platform cache scopes.

## PITFALLS
- QEMU emulation is extremely slow for large images; use native ARM64 runners instead.
- Google Chrome does not publish a .deb for ARM64 Linux; Ubuntu's chromium-browser package is a snap shim that doesn't work in Docker.
- Playwright's bundled Chromium sends HeadlessChrome in the User-Agent, which bot detection catches. A simple user_agent override is insufficient; CDP Network.setUserAgentOverride with full metadata is required.
- GHA cache scopes collide when two matrix jobs write to the same scope; add scope=${{ matrix.platform }} to cache-from and cache-to.

## NOTES
- The user corrected the agent multiple times for pushing directly to main; all changes should be on feature branches with PRs.

---

### EXAMPLE: BAD SKILL (REJECTED — too trivial)

Conversation: User asked the agent to open LinkedIn and navigate to the Jobs page.

## REJECTED
Reason: The task is trivial (open a website and click a navigation link). The "happy path" would just be common sense and contains no non-obvious steps or problem-solving.

---

### EXAMPLE: BAD SKILL (REJECTED — just a web search)

Conversation: User asked the agent to search Google for bananas and click the first result.

## REJECTED
Reason: The task is a simple web search with no non-obvious steps, no failures, and no workarounds. Anyone could figure this out in 30 seconds.

---

### EXAMPLE: BAD SKILL (REJECTED — just website navigation)

Conversation: User asked the agent to open a website, log in, and navigate to a page. The agent had trouble with a modal but eventually worked around it.

## REJECTED
Reason: The task is just website navigation. While there was a minor workaround for a modal, the overall workflow (open site, log in, navigate) is common sense and not worth extracting as a reusable skill.

---

### EXAMPLE: BAD SKILL (REJECTED — too generic)

Conversation: User asked the agent to research a topic online and write a summary.

## REJECTED
Reason: The task is too generic to extract a useful skill. The workflow (search, read sources, summarize) is common sense with no non-obvious steps, specific parameters, or workarounds.

---

### EXAMPLE: BAD SKILL (REJECTED — not completed)

Conversation: User asked the agent to create a prompt snippet skill, but the agent drafted it and never saved or registered it.

## REJECTED
Reason: The task was not completed. The agent drafted content but never saved or registered it, so there is no proven happy path to extract.

---

### EXAMPLE: GOOD SKILL (REUSABILITY 3)

Conversation: User wanted to estimate how many downloads a GitHub CLI tool had in the last week. The agent tried npm and PyPI first (failed), then figured out the GitHub Releases API approach.

## SKILL: Estimate Recent Downloads for a GitHub-Distributed CLI Tool

## PROBLEM
User wants to know recent download counts for a CLI tool distributed only via GitHub Releases, not through package registries.

## TASK_TYPE
research

## DIFFICULTY
simple

## REUSABILITY
3

## HAPPY PATH
1. Identify the distribution method by checking the repository structure (e.g., presence of go.mod indicates a Go binary via GitHub Releases).
2. Fetch all releases from the GitHub API: `GET /repos/{owner}/{repo}/releases`.
3. Get the current date using a datetime tool.
4. Filter releases to those published within the target time window.
5. Sum the `download_count` for all assets of those releases.
6. Report the total with a caveat: GitHub only provides cumulative download counts per asset, so downloads from older releases that occurred in the window cannot be isolated.

## PITFALLS
- npm and PyPI download APIs only work if the tool is published on those registries; check the repo structure first.
- GitHub's Releases API only returns cumulative (all-time) download counts per asset; there is no endpoint for time-bounded statistics.

## NOTES
- The agent confirmed the distribution method by inspecting the repository contents (Go project with no package.json or setup.py).

---

Now extract a skill from the conversation above (or reject it). Remember:
- GENERALIZE: Use [bracketed placeholders] for specific values
- Be specific about TOOL NAMES and APPROACH, but abstract away the DATA
- Be strict about REUSABILITY — most tasks are 1-2
- REJECT trivial, incomplete, or too-generic conversations"""


def _parse_skill_response(content):
    """Parse the LLM's skill extraction response into structured fields."""
    # Check for rejection
    if re.search(r"##\s*REJECTED", content, re.IGNORECASE):
        reason_match = re.search(r"Reason:\s*(.+?)(?:\n|$)", content, re.IGNORECASE)
        return {
            "rejected": True,
            "rejection_reason": reason_match.group(1).strip() if reason_match else "No reason given",
        }
    
    def extract_section(text, header):
        """Extract content between a ## header and the next ## header or end."""
        pattern = rf"##\s*{re.escape(header)}\s*\n(.*?)(?=\n##\s|\Z)"
        match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
        return match.group(1).strip() if match else ""
    
    def extract_title(text):
        match = re.search(r"##\s*SKILL:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
        return match.group(1).strip() if match else "(untitled skill)"
    
    def extract_reusability(text):
        match = re.search(r"##\s*REUSABILITY\s*\n.*?(\d)", text, re.DOTALL | re.IGNORECASE)
        if match:
            return int(match.group(1))
        return 3  # Default to middle if not found
    
    return {
        "rejected": False,
        "skill_title": extract_title(content),
        "problem": extract_section(content, "PROBLEM"),
        "task_type": extract_section(content, "TASK_TYPE").strip().lower() or "other",
        "difficulty": extract_section(content, "DIFFICULTY").strip().lower() or "medium",
        "reusability": extract_reusability(content),
        "happy_path": extract_section(content, "HAPPY PATH"),
        "pitfalls": extract_section(content, "PITFALLS"),
        "notes": extract_section(content, "NOTES"),
    }


def _extract_skill(model, trajectory, timeout=90):
    """Send a compressed trajectory to the LLM and extract a skill."""
    prompt = SKILL_EXTRACTION_PROMPT.replace("{trajectory}", trajectory)
    
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.3, "num_ctx": 32768},
    }
    
    try:
        response = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=timeout)
        if response.status_code != 200:
            return {"error": f"HTTP {response.status_code}"}
        
        data = response.json()
        content = data.get("message", {}).get("content", "")
        if not content:
            return {"error": "Empty response from model"}
        
        parsed = _parse_skill_response(content)
        parsed["raw_response"] = content
        return parsed
    except requests.exceptions.Timeout:
        return {"error": "Model timed out"}
    except Exception as e:
        return {"error": str(e)}


@action
def get_skill_status():
    """Check how many conversations have skills extracted vs pending."""
    conn = get_db()
    try:
        total = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        extracted = conn.execute("SELECT COUNT(*) FROM skills").fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM conversations WHERE processed_skill = 0 OR processed_skill IS NULL").fetchone()[0]
        
        # Count by task type
        type_counts = {}
        for row in conn.execute("SELECT task_type, COUNT(*) as cnt FROM skills GROUP BY task_type").fetchall():
            type_counts[row["task_type"]] = row["cnt"]
        
        return {
            "total_conversations": total,
            "skills_extracted": extracted,
            "pending": pending,
            "type_counts": type_counts,
        }
    finally:
        conn.close()


@action
def process_skills_batch(model: str = "", max_seconds: int = 100):
    """Process a batch of conversations for skill extraction via Ollama.
    
    Picks unprocessed conversations, sends their compressed trajectories to the
    LLM, parses the response, and stores the extracted skill. Skips trivial
    conversations and low-reusability skills.
    """
    model = model or DEFAULT_SKILL_MODEL
    
    conn = get_db()
    try:
        # Find conversations without skills, skipping trivial ones
        # Skip: < 5 tool calls (too simple), < 1000 est_tokens (too short)
        pending = conn.execute("""
            SELECT id, title, compressed_trajectory, est_tokens, num_tool_calls
            FROM conversations 
            WHERE (processed_skill = 0 OR processed_skill IS NULL)
              AND num_tool_calls >= 5
              AND est_tokens >= 1000
            ORDER BY est_tokens ASC
        """).fetchall()
        
        # Also mark trivial conversations as processed (skip them permanently)
        conn.execute("""
            UPDATE conversations SET processed_skill = 1
            WHERE (processed_skill = 0 OR processed_skill IS NULL)
              AND (num_tool_calls < 5 OR est_tokens < 1000)
        """)
        conn.commit()
        
        if not pending:
            return {"processed": 0, "message": "All conversations have skills extracted (trivial ones skipped)", "remaining": 0}
        
        start_time = time.time()
        processed = 0
        skipped_low_value = 0
        errors = 0
        
        for row in pending:
            if time.time() - start_time > max_seconds:
                break
            
            trajectory = row["compressed_trajectory"]
            if not trajectory or len(trajectory) < 200:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                processed += 1
                continue
            
            result = _extract_skill(model, trajectory)
            
            if "error" in result:
                errors += 1
                continue
            
            # Handle rejections — mark as processed, don't store a skill
            if result.get("rejected"):
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                skipped_low_value += 1
                processed += 1
                continue
            
            # Quality gate: skip skills with reusability < 3
            reusability = result.get("reusability", 3)
            if reusability < 3:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                skipped_low_value += 1
                processed += 1
                continue
            
            # Hard post-filter: reject skills that are too short or too generic
            happy_path = result.get("happy_path", "")
            problem = result.get("problem", "")
            skill_title = result.get("skill_title", "")
            
            # Minimum content requirements
            if len(happy_path) < 200 or len(problem) < 50:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                skipped_low_value += 1
                processed += 1
                continue
            
            # Reject if happy path has fewer than 3 numbered steps
            step_count = len(re.findall(r'^\s*\d+\.', happy_path, re.MULTILINE))
            if step_count < 3:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                skipped_low_value += 1
                processed += 1
                continue
            
            # Quality gate: skip skills with reusability < 3
            reusability = result.get("reusability", 3)
            if reusability < 3:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                skipped_low_value += 1
                processed += 1
                continue
            
            # Dedup check: embed the skill and compare against existing skills
            skill_text_for_embedding = f"{result.get('skill_title', '')} {result.get('problem', '')} {result.get('happy_path', '')[:500]}"
            skill_emb = None
            try:
                resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [skill_text_for_embedding]}, timeout=30)
                if resp.status_code == 200:
                    embs = resp.json().get("embeddings", [])
                    if embs:
                        skill_emb = np.array(embs[0], dtype=np.float32)
            except:
                pass
            
            # Check for duplicates against existing skill embeddings
            is_duplicate = False
            if skill_emb is not None:
                existing_embs = conn.execute("SELECT skill_id, embedding FROM skill_embeddings").fetchall()
                if existing_embs:
                    existing_vectors = np.array([np.frombuffer(r["embedding"], dtype=np.float32) for r in existing_embs])
                    skill_norm = skill_emb / (np.linalg.norm(skill_emb) + 1e-8)
                    existing_norms = existing_vectors / (np.linalg.norm(existing_vectors, axis=1, keepdims=True) + 1e-8)
                    sims = np.dot(existing_norms, skill_norm)
                    if len(sims) > 0 and np.max(sims) > 0.88:
                        is_duplicate = True
                        skipped_low_value += 1  # Count as skipped
            
            if is_duplicate:
                conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
                conn.commit()
                processed += 1
                continue
            
            # Delete any existing skills for this conversation (prevent re-processing dupes)
            conn.execute("DELETE FROM skills WHERE conversation_id = ?", (row["id"],))
            
            # Store the skill
            cursor = conn.execute("""
                INSERT INTO skills 
                (conversation_id, model, skill_title, problem, happy_path, pitfalls, notes, 
                 task_type, difficulty, extracted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                row["id"], model,
                result.get("skill_title", "(untitled)"),
                result.get("problem", ""),
                result.get("happy_path", ""),
                result.get("pitfalls", ""),
                result.get("notes", ""),
                result.get("task_type", "other"),
                result.get("difficulty", "medium"),
                time.time(),
            ))
            skill_id = cursor.lastrowid
            
            # Store skill embedding for future dedup and search
            if skill_emb is not None:
                conn.execute("INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding) VALUES (?, ?)",
                           (skill_id, skill_emb.astype(np.float32).tobytes()))
            
            conn.execute("UPDATE conversations SET processed_skill = 1 WHERE id = ?", (row["id"],))
            conn.commit()
            processed += 1
        
        elapsed = time.time() - start_time
        remaining = len(pending) - processed
        
        return {
            "processed": processed,
            "skipped_low_value": skipped_low_value,
            "errors": errors,
            "remaining": remaining,
            "elapsed": round(elapsed, 1),
            "model": model,
            "message": f"Extracted {processed - skipped_low_value} skill{'s' if processed - skipped_low_value != 1 else ''}, skipped {skipped_low_value} low-value, {errors} error{'s' if errors != 1 else ''}. {remaining} remaining.",
        }
    finally:
        conn.close()


@action
def list_skills(task_type: str = "", sort: str = "date", limit: int = 50):
    """List all extracted skills, optionally filtered by task type."""
    conn = get_db()
    try:
        query = """
            SELECT s.*, c.title as conv_title, c.date, c.num_tool_calls
            FROM skills s
            JOIN conversations c ON s.conversation_id = c.id
        """
        params = []
        
        if task_type:
            query += " WHERE s.task_type = ?"
            params.append(task_type)
        
        if sort == "difficulty":
            query += " ORDER BY CASE s.difficulty WHEN 'complex' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"
        elif sort == "title":
            query += " ORDER BY s.skill_title"
        else:
            query += " ORDER BY c.date DESC"
        
        query += f" LIMIT {limit}"
        
        rows = conn.execute(query, params).fetchall()
        
        return {
            "skills": [
                {
                    "id": r["id"],
                    "conversation_id": r["conversation_id"],
                    "skill_title": r["skill_title"],
                    "problem": r["problem"],
                    "task_type": r["task_type"],
                    "difficulty": r["difficulty"],
                    "happy_path": r["happy_path"],
                    "pitfalls": r["pitfalls"],
                    "notes": r["notes"],
                    "model": r["model"],
                    "conv_title": r["conv_title"],
                    "date": r["date"],
                    "num_tool_calls": r["num_tool_calls"],
                    "extracted_at": r["extracted_at"],
                }
                for r in rows
            ],
            "count": len(rows),
        }
    finally:
        conn.close()


@action
def get_skill(conversation_id: str):
    """Get the extracted skill for a specific conversation."""
    conn = get_db()
    try:
        row = conn.execute("""
            SELECT s.*, c.title as conv_title, c.date, c.num_tool_calls, c.num_user_msgs
            FROM skills s
            JOIN conversations c ON s.conversation_id = c.id
            WHERE s.conversation_id = ?
            ORDER BY s.extracted_at DESC
            LIMIT 1
        """, (conversation_id,)).fetchone()
        
        if not row:
            return {"error": "No skill found for this conversation"}
        
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "skill_title": row["skill_title"],
            "problem": row["problem"],
            "task_type": row["task_type"],
            "difficulty": row["difficulty"],
            "happy_path": row["happy_path"],
            "pitfalls": row["pitfalls"],
            "notes": row["notes"],
            "model": row["model"],
            "conv_title": row["conv_title"],
            "date": row["date"],
            "num_tool_calls": row["num_tool_calls"],
            "num_user_msgs": row["num_user_msgs"],
            "events_path": os.path.join(CONV_DIR, row["conversation_id"], "events.jsonl"),
        }
    finally:
        conn.close()


@action
def reextract_skill(conversation_id: str, model: str = ""):
    """Re-run skill extraction on a conversation with a different model."""
    model = model or DEFAULT_SKILL_MODEL
    
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT compressed_trajectory FROM conversations WHERE id = ?",
            (conversation_id,)
        ).fetchone()
        
        if not row:
            return {"error": "Conversation not found"}
        
        trajectory = row["compressed_trajectory"]
        if not trajectory:
            return {"error": "No compressed trajectory available. Run sync first."}
        
        result = _extract_skill(model, trajectory)
        
        if "error" in result:
            return {"error": result["error"]}
        
        # Delete old skills for this conversation
        conn.execute("DELETE FROM skills WHERE conversation_id = ?", (conversation_id,))
        
        # Store new skill
        cursor = conn.execute("""
            INSERT INTO skills 
            (conversation_id, model, skill_title, problem, happy_path, pitfalls, notes,
             task_type, difficulty, extracted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            conversation_id, model,
            result.get("skill_title", "(untitled)"),
            result.get("problem", ""),
            result.get("happy_path", ""),
            result.get("pitfalls", ""),
            result.get("notes", ""),
            result.get("task_type", "other"),
            result.get("difficulty", "medium"),
            time.time(),
        ))
        skill_id = cursor.lastrowid
        
        # Store embedding
        skill_text = f"{result.get('skill_title', '')} {result.get('problem', '')} {result.get('happy_path', '')[:500]}"
        try:
            resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [skill_text]}, timeout=30)
            if resp.status_code == 200:
                embs = resp.json().get("embeddings", [])
                if embs:
                    emb = np.array(embs[0], dtype=np.float32)
                    conn.execute("INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding) VALUES (?, ?)",
                               (skill_id, emb.astype(np.float32).tobytes()))
        except:
            pass
        
        conn.commit()
        
        return {
            "success": True,
            "skill_title": result.get("skill_title", ""),
            "reusability": result.get("reusability", 0),
            "model": model,
            "message": f"Re-extracted skill with {model}",
        }
    finally:
        conn.close()


@action
def search_skills(query: str, limit: int = 10):
    """Search consolidated skills by keyword matching.
    
    Searches skill titles, problem descriptions, and happy paths
    for matching terms. Falls back to consolidated skills since
    per-conversation skills are not currently extracted.
    """
    if not query or not query.strip():
        return {"results": [], "query": query}
    
    query_lower = query.strip().lower()
    query_tokens = set(tokenize(query_lower))
    
    conn = get_db()
    try:
        # First try consolidated skills (they're the ones with data)
        rows = conn.execute("""
            SELECT id, skill_title, problem, task_type, difficulty, reusability,
                   happy_path, pitfalls, notes, conversation_ids
            FROM consolidated_skills
            ORDER BY reusability DESC
        """).fetchall()
        
        if not rows:
            return {"results": [], "query": query, "message": "No consolidated skills found."}
        
        # Score each skill by keyword overlap
        scored = []
        for r in rows:
            search_text = f"{r['skill_title'] or ''} {r['problem'] or ''} {r['happy_path'] or ''} {r['pitfalls'] or ''}".lower()
            search_tokens = set(tokenize(search_text))
            
            # Jaccard-like overlap score
            overlap = len(query_tokens & search_tokens)
            if overlap == 0:
                continue
            
            score = overlap / len(query_tokens)  # recall-based: fraction of query terms found
            
            # Title match bonus
            title_tokens = set(tokenize(r['skill_title'] or ''))
            title_overlap = len(query_tokens & title_tokens)
            if title_overlap > 0:
                score += 0.3 * (title_overlap / len(query_tokens))
            
            scored.append((score, r))
        
        # Sort by score descending
        scored.sort(key=lambda x: x[0], reverse=True)
        
        results = []
        for score, r in scored[:limit]:
            conv_ids = json.loads(r["conversation_ids"]) if r["conversation_ids"] else []
            # Get conversation titles
            conv_titles = []
            for cid in conv_ids[:3]:
                c = conn.execute("SELECT title, date FROM conversations WHERE id = ?", (cid,)).fetchone()
                if c:
                    conv_titles.append(f"{c['title']} ({c['date']})")
            
            results.append({
                "skill_id": r["id"],
                "conversation_id": conv_ids[0] if conv_ids else "",
                "skill_title": r["skill_title"] or "(untitled)",
                "problem": (r["problem"] or "")[:300],
                "task_type": r["task_type"] or "other",
                "difficulty": r["difficulty"] or "medium",
                "happy_path": (r["happy_path"] or "")[:500],
                "similarity": round(score, 4),
                "conv_title": conv_titles[0] if conv_titles else "",
                "date": "",
            })
        
        return {
            "query": query,
            "total_skills_searched": len(rows),
            "results": results,
        }
    finally:
        conn.close()


# ─── Consolidated Skills + Failure Patterns (v2) ───────────────

@action
def list_consolidated_skills(task_type: str = "", limit: int = 50):
    """List consolidated skills (clustered, one per task type)."""
    conn = get_db()
    try:
        query = "SELECT * FROM consolidated_skills"
        params = []
        if task_type:
            query += " WHERE task_type LIKE ?"
            params.append(f"%{task_type}%")
        query += " ORDER BY reusability DESC, extracted_at DESC LIMIT ?"
        params.append(limit)
        
        rows = conn.execute(query, params).fetchall()
        
        return {
            "skills": [
                {
                    "id": r["id"],
                    "cluster_id": r["cluster_id"],
                    "skill_title": r["skill_title"] or "(untitled)",
                    "problem": r["problem"],
                    "task_type": r["task_type"],
                    "difficulty": r["difficulty"],
                    "reusability": r["reusability"],
                    "happy_path": r["happy_path"],
                    "pitfalls": r["pitfalls"],
                    "notes": r["notes"],
                    "failure_patterns": json.loads(r["failure_patterns"]) if r["failure_patterns"] else [],
                    "conversation_ids": json.loads(r["conversation_ids"]) if r["conversation_ids"] else [],
                    "model": r["model"],
                }
                for r in rows
            ],
            "count": len(rows),
        }
    finally:
        conn.close()

@action
def get_consolidated_skill(skill_id: int):
    """Get a single consolidated skill with all details."""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM consolidated_skills WHERE id = ?", (skill_id,)).fetchone()
        if not row:
            return {"error": "Skill not found"}
        
        # Get conversation titles for this cluster
        conv_ids = json.loads(row["conversation_ids"]) if row["conversation_ids"] else []
        conv_titles = []
        for cid in conv_ids:
            c = conn.execute("SELECT title, date FROM conversations WHERE id = ?", (cid,)).fetchone()
            if c:
                conv_titles.append({"id": cid, "title": c["title"], "date": c["date"]})
        
        return {
            "id": row["id"],
            "cluster_id": row["cluster_id"],
            "skill_title": row["skill_title"] or "(untitled)",
            "problem": row["problem"],
            "task_type": row["task_type"],
            "difficulty": row["difficulty"],
            "reusability": row["reusability"],
            "happy_path": row["happy_path"],
            "pitfalls": row["pitfalls"],
            "notes": row["notes"],
            "failure_patterns": json.loads(row["failure_patterns"]) if row["failure_patterns"] else [],
            "conversations": conv_titles,
            "model": row["model"],
        }
    finally:
        conn.close()

@action
def list_failure_patterns():
    """List all failure patterns with source references."""
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT fp.id, fp.pattern_text, fp.context, fp.failure_type, fp.frequency, 
                   fp.recovery, fp.source_conversations, fp.source_context
            FROM failure_patterns fp
            ORDER BY fp.frequency DESC, fp.extracted_at DESC
        """).fetchall()
        
        patterns = []
        for r in rows:
            # Get conversation titles for source conversations
            conv_ids = json.loads(r["source_conversations"]) if r["source_conversations"] else []
            conv_titles = []
            for cid in conv_ids:
                c = conn.execute("SELECT title, date FROM conversations WHERE id = ?", (cid,)).fetchone()
                if c:
                    conv_titles.append({"id": cid, "title": c["title"], "date": c["date"]})
            
            # Parse source context
            source_ctx = json.loads(r["source_context"]) if r["source_context"] else None
            
            patterns.append({
                "id": r["id"],
                "pattern_text": r["pattern_text"],
                "context": r["context"],
                "frequency": r["frequency"],
                "recovery": r["recovery"],
                "source_conversations": conv_titles,
                "source_context": source_ctx,
            })
        
        return {
            "patterns": patterns,
            "count": len(patterns),
        }
    finally:
        conn.close()

@action
def get_extraction_status():
    """Get status of consolidated skills and failure patterns."""
    conn = get_db()
    try:
        skills = conn.execute("SELECT COUNT(*) FROM consolidated_skills").fetchone()[0]
        patterns = conn.execute("SELECT COUNT(*) FROM failure_patterns").fetchone()[0]
        clusters = conn.execute("SELECT COUNT(DISTINCT cluster_id) FROM conversation_clusters WHERE cluster_id != -1").fetchone()[0]
        noise = conn.execute("SELECT COUNT(*) FROM conversation_clusters WHERE cluster_id = -1").fetchone()[0]
        
        return {
            "consolidated_skills": skills,
            "failure_patterns": patterns,
            "clusters": clusters,
            "noise_conversations": noise,
        }
    finally:
        conn.close()