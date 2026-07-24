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

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kb.db")
OLLAMA_URL = "http://localhost:11434/api/embed"
OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
EMBED_MODEL = "nomic-embed-text"
EMBED_DIM = 768
CONV_DIR = "/var/lib/omnideck/conversations"
DEFAULT_SKILL_MODEL = "huihui_ai/qwen3.5-abliterated:35b"


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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


def tokenize(text):
    """Simple tokenizer for keyword search."""
    text = text.lower()
    tokens = re.findall(r'[a-z0-9]+', text)
    return tokens

def keyword_search(conn, query_tokens, all_chunks):
    """Compute BM25-like keyword scores for each chunk.
    
    Returns a dict of chunk_id -> keyword_score.
    """
    if not query_tokens:
        return {}
    
    # Build document frequency (how many chunks contain each term)
    df = {}
    for chunk in all_chunks:
        chunk_tokens = set(tokenize(chunk["chunk_text"]))
        for token in chunk_tokens:
            df[token] = df.get(token, 0) + 1
    
    N = len(all_chunks)
    avgdl = sum(len(tokenize(c["chunk_text"])) for c in all_chunks) / max(N, 1)
    
    scores = {}
    k1 = 1.5
    b = 0.75
    
    for chunk in all_chunks:
        chunk_tokens = tokenize(chunk["chunk_text"])
        chunk_len = len(chunk_tokens)
        if chunk_len == 0:
            scores[chunk["id"]] = 0
            continue
        
        # Term frequency in this chunk
        tf = {}
        for token in chunk_tokens:
            tf[token] = tf.get(token, 0) + 1
        
        score = 0.0
        for qt in query_tokens:
            if qt not in tf:
                continue
            # IDF
            n = df.get(qt, 0)
            if n == 0:
                continue
            idf = math.log((N - n + 0.5) / (n + 0.5) + 1)
            # BM25 term score
            term_score = idf * (tf[qt] * (k1 + 1)) / (tf[qt] + k1 * (1 - b + b * chunk_len / max(avgdl, 1)))
            score += term_score
        
        # Title boost: if query terms appear in the conversation title, boost
        title_tokens = set(tokenize(chunk.get("title", "")))
        title_matches = sum(1 for qt in query_tokens if qt in title_tokens)
        if title_matches > 0:
            score *= (1 + 0.5 * title_matches)
        
        scores[chunk["id"]] = score
    
    return scores

@action
def search(query: str, limit: int = 20):
    """Hybrid search (semantic + keyword) across all conversation chunks.
    
    Combines cosine similarity from embeddings with BM25 keyword matching
    to get the best of both worlds. Results are grouped by conversation.
    """
    if not query or not query.strip():
        return {"results": [], "query": query}
    
    query = query.strip()
    query_tokens = tokenize(query)
    
    query_emb = embed_query(query)
    
    conn = get_db()
    try:
        # Load all chunks with embeddings and metadata
        rows = conn.execute("""
            SELECT se.id, se.conversation_id, se.chunk_type, se.chunk_index, 
                   se.chunk_text, se.embedding, c.title, c.date
            FROM search_embeddings se
            JOIN conversations c ON se.conversation_id = c.id
        """).fetchall()
        
        if not rows:
            return {"results": [], "query": query, "message": "No indexed conversations found. Run build_index.py first."}
        
        # Convert to list of dicts for keyword search
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
        
        # Semantic scores
        if query_emb is not None:
            doc_embs = np.array([
                np.frombuffer(r["embedding"], dtype=np.float32) for r in rows
            ])
            sem_sims = cosine_similarity(query_emb, doc_embs)
            # Normalize to 0-1 range (cosine sim can be negative)
            sem_sims = (sem_sims + 1) / 2
        else:
            sem_sims = np.zeros(len(rows))
        
        # Keyword scores
        kw_scores = keyword_search(conn, query_tokens, all_chunks)
        
        # Normalize keyword scores to 0-1
        max_kw = max(kw_scores.values()) if kw_scores else 1
        if max_kw > 0:
            kw_scores = {k: v / max_kw for k, v in kw_scores.items()}
        
        # Combine scores: weighted average
        # Semantic weight 0.4, keyword weight 0.6 (keyword is more reliable for specific terms)
        SEMANTIC_WEIGHT = 0.4
        KEYWORD_WEIGHT = 0.6
        
        combined_scores = []
        for i, chunk in enumerate(all_chunks):
            sem_score = float(sem_sims[i]) if query_emb is not None else 0
            kw_score = kw_scores.get(chunk["id"], 0)
            combined = SEMANTIC_WEIGHT * sem_score + KEYWORD_WEIGHT * kw_score
            combined_scores.append((combined, sem_score, kw_score, chunk))
        
        # Sort by combined score
        combined_scores.sort(key=lambda x: x[0], reverse=True)
        
        # Group by conversation — collect all matching chunks per conversation
        conv_chunks = {}  # conv_id -> list of match dicts
        conv_meta = {}    # conv_id -> {title, date}
        conv_order = []   # track first-appearance order
        
        for combined, sem, kw, chunk in combined_scores:
            conv_id = chunk["conversation_id"]
            if conv_id not in conv_chunks:
                conv_chunks[conv_id] = []
                conv_meta[conv_id] = {"title": chunk["title"], "date": chunk["date"]}
                conv_order.append(conv_id)
            conv_chunks[conv_id].append({
                "score": round(combined, 4),
                "semantic_score": round(sem, 4),
                "keyword_score": round(kw, 4),
                "chunk_type": chunk["chunk_type"],
                "chunk_text": chunk["chunk_text"][:500],
                "chunk_index": chunk["chunk_index"],
            })
        
        # Build results: top `limit` conversations, each with up to 5 matching snippets
        results = []
        for conv_id in conv_order[:limit]:
            chunks = conv_chunks[conv_id]
            best = chunks[0]
            meta = conv_meta[conv_id]
            results.append({
                "conversation_id": conv_id,
                "title": meta["title"],
                "date": meta["date"],
                "score": best["score"],
                "match_count": len(chunks),
                "events_path": os.path.join(CONV_DIR, conv_id, "events.jsonl"),
                "matches": chunks[:5],
            })
        
        return {
            "query": query,
            "total_chunks_searched": len(rows),
            "results": results,
        }
    finally:
        conn.close()


@action
def get_conversation(conversation_id: str):
    """Get the full compressed trajectory for a conversation."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,)
        ).fetchone()
        
        if not row:
            return {"error": "Conversation not found"}
        
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
            "trajectory": row["compressed_trajectory"],
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
        
        for d in sorted(os.listdir(CONV_DIR)):
            if d.startswith("_") or d == "routines":
                continue
            events_path = os.path.join(CONV_DIR, d, "events.jsonl")
            if not os.path.exists(events_path):
                continue
            on_disk += 1
            
            # Check if in DB
            row = conn.execute("SELECT id, indexed_at FROM conversations WHERE id = ?", (d,)).fetchone()
            file_mtime = os.path.getmtime(events_path)
            
            if not row:
                new_convs.append(d)
            elif row["indexed_at"] and file_mtime > row["indexed_at"]:
                updated_convs.append(d)
        
        return {
            "indexed": indexed,
            "on_disk": on_disk,
            "new_conversations": len(new_convs),
            "updated_conversations": len(updated_convs),
            "needs_sync": len(new_convs) + len(updated_convs) > 0,
        }
    finally:
        conn.close()

@action
def sync(max_seconds: int = 100):
    """Sync the index with new and updated conversations.
    
    Scans for conversations not yet indexed (or with updated events.jsonl),
    processes them, and returns stats. Designed to fit within the 120s action timeout.
    """
    conn = get_db()
    try:
        # Ensure indexed_at column exists
        try:
            conn.execute("ALTER TABLE conversations ADD COLUMN indexed_at REAL")
            conn.commit()
        except:
            pass  # Column already exists
        
        # Find conversations that need processing
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
        
        if not to_process:
            return {"processed": 0, "message": "Index is up to date", "new_conversations": 0, "updated_conversations": 0}
        
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
        
        return {
            "processed": processed,
            "new_conversations": is_new,
            "updated_conversations": is_updated,
            "remaining": len(to_process) - processed,
            "elapsed": round(elapsed, 1),
            "message": f"Processed {processed} conversation{'s' if processed != 1 else ''} ({is_new} new, {is_updated} updated) in {elapsed:.1f}s",
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
    """Semantic search across extracted skills by meaning.
    
    Embeds the query and compares against skill embeddings to find
    the most relevant skills, regardless of keyword matching.
    """
    if not query or not query.strip():
        return {"results": [], "query": query}
    
    query_emb = embed_query(query.strip())
    if query_emb is None:
        return {"error": "Failed to generate query embedding. Is Ollama running?", "results": []}
    
    conn = get_db()
    try:
        # Load all skill embeddings
        rows = conn.execute("""
            SELECT se.skill_id, se.embedding, s.skill_title, s.problem, s.task_type, 
                   s.difficulty, s.happy_path, s.pitfalls, s.notes, s.conversation_id,
                   c.title as conv_title, c.date
            FROM skill_embeddings se
            JOIN skills s ON se.skill_id = s.id
            JOIN conversations c ON s.conversation_id = c.id
        """).fetchall()
        
        if not rows:
            return {"results": [], "query": query, "message": "No skill embeddings found. Extract skills first."}
        
        # Compute similarities
        doc_embs = np.array([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        sims = cosine_similarity(query_emb, doc_embs)
        
        # Sort by similarity
        top_indices = np.argsort(sims)[::-1][:limit]
        
        results = []
        for idx in top_indices:
            row = rows[idx]
            sim = float(sims[idx])
            results.append({
                "skill_id": row["skill_id"],
                "conversation_id": row["conversation_id"],
                "skill_title": row["skill_title"],
                "problem": row["problem"][:300],
                "task_type": row["task_type"],
                "difficulty": row["difficulty"],
                "happy_path": row["happy_path"][:500],
                "similarity": round(sim, 4),
                "conv_title": row["conv_title"],
                "date": row["date"],
            })
        
        return {
            "query": query,
            "total_skills_searched": len(rows),
            "results": results,
        }
    finally:
        conn.close()