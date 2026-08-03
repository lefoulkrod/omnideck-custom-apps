"""
extraction.py — Consolidated skill extraction + failure pattern extraction.

Uses HDBSCAN clustering to group similar conversations, then sends each cluster
to an LLM to produce ONE consolidated skill with failure workarounds.
Also scans all conversations for failure patterns (anti-patterns).
"""

import json
import os
import re
import time
import sqlite3
import numpy as np
import requests
from sklearn.cluster import HDBSCAN
from sklearn.decomposition import PCA
from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kb.db")
CONV_DIR = "/var/lib/omnideck/conversations"
OLLAMA_URL = "http://localhost:11434/api/embed"
OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
EMBED_MODEL = "qwen3-embedding:8b"
EMBED_DIM = 4096
DEFAULT_SKILL_MODEL = "huihui_ai/qwen3.5-abliterated:35b"

# ─── Database ──────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def ensure_tables(conn):
    """Create new tables if they don't exist."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversation_clusters (
            conversation_id TEXT,
            cluster_id INTEGER,
            cluster_label TEXT,
            PRIMARY KEY (conversation_id)
        );
        
        CREATE TABLE IF NOT EXISTS failure_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern_text TEXT,
            context TEXT,
            failure_type TEXT,
            frequency INTEGER DEFAULT 1,
            source_conversations TEXT,
            recovery TEXT,
            embedding BLOB,
            extracted_at REAL
        );
        
        CREATE TABLE IF NOT EXISTS consolidated_skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cluster_id INTEGER,
            skill_title TEXT,
            problem TEXT,
            task_type TEXT,
            difficulty TEXT,
            reusability INTEGER,
            happy_path TEXT,
            pitfalls TEXT,
            notes TEXT,
            failure_patterns TEXT,
            conversation_ids TEXT,
            model TEXT,
            extracted_at REAL
        );
    """)
    conn.commit()

# ─── Clustering ────────────────────────────────────────────────

def get_conversation_summaries(conn):
    """Get title + first user message for each conversation."""
    summaries = []
    rows = conn.execute("SELECT id, title, compressed_trajectory FROM conversations ORDER BY id").fetchall()
    for row in rows:
        # Extract first user message from trajectory
        traj = row["compressed_trajectory"] or ""
        first_msg = ""
        m = re.search(r"## USER MESSAGE:\n(.+?)(?:\n\n|\Z)", traj, re.DOTALL)
        if m:
            first_msg = m.group(1).strip()[:200]
        summary = f"{row['title']}. {first_msg}"
        summaries.append({"id": row["id"], "title": row["title"], "summary": summary})
    return summaries

def embed_texts(texts, batch_size=20):
    """Embed texts using Ollama."""
    all_embs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        try:
            resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": batch}, timeout=120)
            if resp.status_code == 200:
                for emb in resp.json().get("embeddings", []):
                    all_embs.append(np.array(emb, dtype=np.float32))
            else:
                for _ in batch:
                    all_embs.append(np.zeros(EMBED_DIM, dtype=np.float32))
        except:
            for _ in batch:
                all_embs.append(np.zeros(EMBED_DIM, dtype=np.float32))
    return all_embs

def cluster_conversations():
    """Cluster conversations using HDBSCAN on PCA-reduced embeddings.
    
    Returns list of clusters, each with conversation IDs and titles.
    """
    conn = get_db()
    ensure_tables(conn)
    
    summaries = get_conversation_summaries(conn)
    if len(summaries) < 3:
        return {"error": "Not enough conversations to cluster"}
    
    # Embed summaries
    texts = [s["summary"] for s in summaries]
    embs = np.array(embed_texts(texts))
    
    # PCA dimensionality reduction
    pca = PCA(n_components=min(50, len(summaries) - 1), random_state=42)
    reduced = pca.fit_transform(embs)
    
    # HDBSCAN clustering
    clusterer = HDBSCAN(
        min_cluster_size=3,
        min_samples=2,
        metric='euclidean',
        cluster_selection_method='eom',
    )
    labels = clusterer.fit_predict(reduced)
    
    # Store cluster assignments
    conn.execute("DELETE FROM conversation_clusters")
    for i, s in enumerate(summaries):
        label = int(labels[i])
        conn.execute(
            "INSERT OR REPLACE INTO conversation_clusters (conversation_id, cluster_id, cluster_label) VALUES (?, ?, ?)",
            (s["id"], label if label != -1 else -1, f"cluster_{label}" if label != -1 else "noise")
        )
    conn.commit()
    
    # Build cluster info
    clusters = []
    for cluster_id in sorted(set(labels)):
        if cluster_id == -1:
            continue
        members = [i for i, l in enumerate(labels) if l == cluster_id]
        member_info = [{"id": summaries[idx]["id"], "title": summaries[idx]["title"]} for idx in members]
        
        # Quality score
        member_embs = embs[members]
        sims = sklearn_cosine(member_embs)
        mask = ~np.eye(len(members), dtype=bool)
        avg_sim = float(sims[mask].mean()) if len(members) > 1 else 0.0
        
        clusters.append({
            "cluster_id": int(cluster_id),
            "size": len(members),
            "avg_similarity": round(avg_sim, 3),
            "conversations": member_info,
        })
    
    noise_count = sum(1 for l in labels if l == -1)
    
    conn.close()
    
    return {
        "total_conversations": len(summaries),
        "clusters_found": len(clusters),
        "noise_points": noise_count,
        "clusters": clusters,
    }

# ─── Consolidated Skill + Failure Extraction ─────────────────────

CONSOLIDATED_PROMPT = """You are a skill and failure pattern extractor. You are given {n} conversations that all involve the same type of task. Your job is to consolidate them into ONE generalized skill with a happy path, AND extract all the failure patterns (anti-patterns) observed across these conversations.

Here are the {n} conversation trajectories:

{trajectories}

Analyze ALL of these conversations together and extract:

## SKILL: [concise, generalized title for this class of task]

## PROBLEM
[1-2 sentence description of the general class of problem]

## TASK_TYPE
[One word: research, build, configure, qa, debug, or other]

## DIFFICULTY
[One word: simple, medium, or complex]

## REUSABILITY
[A single number 1-5. Be strict. 1-2 = trivial, 3 = moderate, 4 = high (non-obvious steps, real problem-solving), 5 = expert-level]

## HAPPY PATH
[The MINIMAL generalized steps that would solve this type of task efficiently. Consolidate the common successful approach across all conversations. Use [bracketed placeholders] for specific values. Only include steps that actually worked.]

## PITFALLS
[All failure modes observed across these conversations. For each: what was tried, why it failed, and what works instead. Be specific about tool names and failure modes but generalize the data.]

## FAILURE PATTERNS
[Extract each distinct anti-pattern as a separate entry. Format each as:]
- PATTERN: [When doing X, don't do Y because Z. Use W instead.]
  CONTEXT: [what type of task this applies to]
  FREQUENCY: [how many of the {n} conversations had this failure]
  RECOVERY: [what works instead, if anything]

## NOTES
[Any cross-conversation observations: common tools, patterns, user corrections, etc.]

Rules:
- GENERALIZE: Use [placeholders] for specific values. This skill should work for ANY similar task.
- CONSOLIDATE: Find the common successful approach across ALL conversations, not just one.
- BE SPECIFIC about tool names and failure modes, but abstract away specific data.
- Extract ALL failure patterns, not just the most common ones.
- If a failure appears in only 1 conversation, still extract it — it might save someone time.
- The happy path should be the proven approach, not a theoretical one."""

def parse_consolidated_response(content):
    """Parse the LLM's consolidated response."""
    def extract_section(text, header):
        pattern = rf"##\s*{re.escape(header)}\s*\n(.*?)(?=\n##\s|\Z)"
        match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
        return match.group(1).strip() if match else ""
    
    def extract_title(text):
        match = re.search(r"##\s*SKILL:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
        return match.group(1).strip() if match else "(untitled)"
    
    def extract_reusability(text):
        match = re.search(r"##\s*REUSABILITY\s*\n.*?(\d)", text, re.DOTALL | re.IGNORECASE)
        return int(match.group(1)) if match else 3
    
    # Parse failure patterns
    failure_section = extract_section(content, "FAILURE PATTERNS")
    patterns = []
    for block in failure_section.split("\n- PATTERN:"):
        block = block.strip()
        if not block or not block.startswith("PATTERN:") and "PATTERN:" not in block:
            continue
        # Clean up
        if not block.startswith("PATTERN:"):
            block = "PATTERN:" + block
        
        pattern_match = re.match(r"PATTERN:\s*(.+?)(?:\n|$)", block, re.DOTALL)
        context_match = re.search(r"CONTEXT:\s*(.+?)(?:\n|$)", block)
        freq_match = re.search(r"FREQUENCY:\s*(.+?)(?:\n|$)", block)
        recovery_match = re.search(r"RECOVERY:\s*(.+?)(?:\n|$)", block)
        
        if pattern_match:
            patterns.append({
                "pattern_text": pattern_match.group(1).strip(),
                "context": context_match.group(1).strip() if context_match else "",
                "frequency_text": freq_match.group(1).strip() if freq_match else "",
                "recovery": recovery_match.group(1).strip() if recovery_match else "",
            })
    
    return {
        "skill_title": extract_title(content),
        "problem": extract_section(content, "PROBLEM"),
        "task_type": extract_section(content, "TASK_TYPE").strip().lower() or "other",
        "difficulty": extract_section(content, "DIFFICULTY").strip().lower() or "medium",
        "reusability": extract_reusability(content),
        "happy_path": extract_section(content, "HAPPY PATH"),
        "pitfalls": extract_section(content, "PITFALLS"),
        "failure_patterns": patterns,
        "notes": extract_section(content, "NOTES"),
    }

def process_consolidated_skills(model=DEFAULT_SKILL_MODEL, max_seconds=100):
    """Cluster conversations, then extract consolidated skills + failure patterns per cluster."""
    conn = get_db()
    ensure_tables(conn)
    
    # Step 1: Cluster
    cluster_result = cluster_conversations()
    if "error" in cluster_result:
        conn.close()
        return cluster_result
    
    clusters = [c for c in cluster_result["clusters"] if c["size"] >= 3]
    if not clusters:
        conn.close()
        return {"error": "No clusters with 3+ conversations found"}
    
    # Step 2: Extract consolidated skill per cluster
    start_time = time.time()
    processed = 0
    total_patterns = 0
    
    for cluster in clusters:
        if time.time() - start_time > max_seconds:
            break
        
        # Get trajectories for this cluster
        trajectories = []
        conv_ids = []
        for conv in cluster["conversations"]:
            row = conn.execute("SELECT compressed_trajectory FROM conversations WHERE id = ?", (conv["id"],)).fetchone()
            if row and row["compressed_trajectory"]:
                traj = row["compressed_trajectory"]
                # Truncate very long trajectories to fit in context
                if len(traj) > 15000:
                    traj = traj[:15000] + "\n... [truncated]"
                trajectories.append(f"--- Conversation: {conv['title']} ---\n{traj}")
                conv_ids.append(conv["id"])
        
        if not trajectories:
            continue
        
        combined = "\n\n".join(trajectories)
        prompt = CONSOLIDATED_PROMPT.replace("{n}", str(len(trajectories))).replace("{trajectories}", combined)
        
        # Call LLM
        try:
            resp = requests.post(OLLAMA_CHAT_URL, json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.3, "num_ctx": 32768},
            }, timeout=90)
            
            if resp.status_code != 200:
                continue
            
            content = resp.json().get("message", {}).get("content", "")
            if not content:
                continue
            
            parsed = parse_consolidated_response(content)
            
            # Quality gate
            if parsed["reusability"] < 3:
                continue
            
            # Store consolidated skill
            # Delete old skill for this cluster
            conn.execute("DELETE FROM consolidated_skills WHERE cluster_id = ?", (cluster["cluster_id"],))
            
            cursor = conn.execute("""
                INSERT INTO consolidated_skills 
                (cluster_id, skill_title, problem, task_type, difficulty, reusability,
                 happy_path, pitfalls, notes, failure_patterns, conversation_ids, model, extracted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                cluster["cluster_id"],
                parsed["skill_title"],
                parsed["problem"],
                parsed["task_type"],
                parsed["difficulty"],
                parsed["reusability"],
                parsed["happy_path"],
                parsed["pitfalls"],
                parsed["notes"],
                json.dumps(parsed["failure_patterns"]),
                json.dumps(conv_ids),
                model,
                time.time(),
            ))
            
            # Store failure patterns
            for fp in parsed["failure_patterns"]:
                # Embed the pattern for dedup
                fp_text = fp["pattern_text"]
                fp_emb = None
                try:
                    emb_resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [fp_text]}, timeout=30)
                    if emb_resp.status_code == 200:
                        embs = emb_resp.json().get("embeddings", [])
                        if embs:
                            fp_emb = np.array(embs[0], dtype=np.float32)
                except:
                    pass
                
                # Check for duplicates
                is_dup = False
                if fp_emb is not None:
                    existing = conn.execute("SELECT id, embedding FROM failure_patterns WHERE embedding IS NOT NULL").fetchall()
                    for ex in existing:
                        ex_emb = np.frombuffer(ex["embedding"], dtype=np.float32)
                        sim = float(np.dot(fp_emb / (np.linalg.norm(fp_emb) + 1e-8), 
                                          ex_emb / (np.linalg.norm(ex_emb) + 1e-8)))
                        if sim > 0.88:
                            # Update frequency
                            conn.execute("UPDATE failure_patterns SET frequency = frequency + 1 WHERE id = ?", (ex["id"],))
                            is_dup = True
                            break
                
                if not is_dup:
                    conn.execute("""
                        INSERT INTO failure_patterns 
                        (pattern_text, context, failure_type, frequency, source_conversations, recovery, embedding, extracted_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        fp_text,
                        fp.get("context", ""),
                        "consolidated",
                        1,
                        json.dumps(conv_ids),
                        fp.get("recovery", ""),
                        fp_emb.astype(np.float32).tobytes() if fp_emb is not None else None,
                        time.time(),
                    ))
                    total_patterns += 1
            
            conn.commit()
            processed += 1
            
        except Exception as e:
            conn.rollback()
            continue
    
    elapsed = time.time() - start_time
    conn.close()
    
    return {
        "clusters_processed": processed,
        "total_clusters": len(clusters),
        "failure_patterns_extracted": total_patterns,
        "elapsed": round(elapsed, 1),
        "message": f"Extracted {processed} consolidated skills with {total_patterns} failure patterns in {elapsed:.1f}s",
    }

# ─── Failure Pattern Extraction (from all conversations) ─────────

FAILURE_SIGNALS = {
    "explicit_error": [
        "traceback", "exception", "permission denied", "no such file", 
        "does not exist", "not found", "error:", "failed to"
    ],
    "self_correction": [
        "didn't work", "doesn't work", "doesn't seem", "that didn't",
        "let me try a different", "let me try again", "unfortunately",
        "wasn't able", "was not able", "that approach", "this isn't",
        "the issue is", "the problem is", "that's not quite"
    ],
    "user_correction": [
        "try again", "no don't", "no dont", "forget that", "forget the",
        "not right", "thats not", "that's not", "redo", "start over",
        "wrong", "not what", "dont do that", "should be", "supposed to"
    ]
}

def scan_for_failures(conn):
    """Scan all conversations for failure signals. Returns list of failure windows."""
    failures = []
    
    for d in sorted(os.listdir(CONV_DIR)):
        if d.startswith("_") or d == "routines":
            continue
        events_path = os.path.join(CONV_DIR, d, "events.jsonl")
        if not os.path.exists(events_path):
            continue
        
        events = []
        with open(events_path) as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except:
                    pass
        
        # Build a sequence of events with context
        for i, evt in enumerate(events):
            if evt.get("type") == "tool_result":
                content = (evt.get("content") or "").lower()
                failure_type = None
                
                for ftype, patterns in FAILURE_SIGNALS.items():
                    if any(p in content for p in patterns):
                        failure_type = ftype
                        break
                
                if not failure_type:
                    continue
                
                # Get context: previous thinking, this tool call, this result, next thinking
                prev_thinking = ""
                tool_call = ""
                next_thinking = ""
                
                for j in range(max(0, i-3), i):
                    if events[j].get("type") == "iteration":
                        if events[j].get("thinking"):
                            prev_thinking = events[j]["thinking"][:500]
                        if events[j].get("tool_calls"):
                            tc = events[j]["tool_calls"][0]
                            tool_call = f"{tc.get('name', '?')}({json.dumps(tc.get('arguments', {}))[:200]})"
                
                for j in range(i+1, min(len(events), i+3)):
                    if events[j].get("type") == "iteration":
                        if events[j].get("thinking"):
                            next_thinking = events[j]["thinking"][:500]
                        break
                
                failures.append({
                    "conversation_id": d,
                    "failure_type": failure_type,
                    "prev_thinking": prev_thinking,
                    "tool_call": tool_call,
                    "result": (evt.get("content") or "")[:500],
                    "next_thinking": next_thinking,
                })
            
            elif evt.get("type") == "iteration":
                thinking = (evt.get("thinking") or "").lower()
                for pattern in FAILURE_SIGNALS["self_correction"]:
                    if pattern in thinking:
                        # Get context
                        tool_calls = evt.get("tool_calls") or []
                        tool_call = ""
                        if tool_calls:
                            tc = tool_calls[0]
                            tool_call = f"{tc.get('name', '?')}({json.dumps(tc.get('arguments', {}))[:200]})"
                        
                        failures.append({
                            "conversation_id": d,
                            "failure_type": "self_correction",
                            "prev_thinking": (evt.get("thinking") or "")[:500],
                            "tool_call": tool_call,
                            "result": "",
                            "next_thinking": "",
                        })
                        break
            
            elif evt.get("type") == "user_message":
                content = (evt.get("content") or "").lower()
                for pattern in FAILURE_SIGNALS["user_correction"]:
                    if pattern in content:
                        failures.append({
                            "conversation_id": d,
                            "failure_type": "user_correction",
                            "prev_thinking": "",
                            "tool_call": "",
                            "result": "",
                            "next_thinking": (evt.get("content") or "")[:500],
                        })
                        break
    
    return failures

FAILURE_EXTRACTION_PROMPT = """You are a failure pattern extractor. You are given ONE failure event from an AI agent conversation. Extract a generalized anti-pattern from it.

Here is the failure event:

{failure}

Extract a generalized anti-pattern in this exact format:

## ANTI-PATTERN
[One sentence: "When doing [task type], don't [failed action] because [reason]. Use [working approach] instead."]

## CONTEXT
[What type of task this applies to — e.g., "web automation", "file editing", "email operations"]

## RECOVERY
[What works instead, if anything. If no recovery was found, say "No known recovery."]

## SKIP
[If this failure is too specific to be useful (e.g., a unique file path not found, a one-off typo, a SIGPIPE from a backgrounded process), output "SKIP" here instead of the above sections.]

Rules:
- GENERALIZE: Abstract away specific values into [placeholders]. "When editing files with special characters, don't use apply_text_patch directly because apostrophes break matching" not "When editing /home/user/file.py line 42..."
- Be specific about TOOL NAMES and failure modes
- Only extract patterns that would apply to FUTURE similar tasks
- SKIP trivial failures (SIGPIPE, file not found for unique paths, network timeouts on specific URLs)"""

def extract_failure_patterns(model=DEFAULT_SKILL_MODEL, max_seconds=100):
    """Scan all conversations for failures and extract anti-patterns.
    
    Processes failures one at a time (per the research approach), prioritizing
    user corrections and agent self-corrections over generic errors.
    Caches scan results to avoid re-scanning on each batch.
    """
    conn = get_db()
    ensure_tables(conn)
    
    # Check for cached scan results
    cache_path = os.path.join(os.path.dirname(DB_PATH), "failure_scan_cache.json")
    
    if not os.path.exists(cache_path):
        # Scan once and cache
        print("Scanning conversations for failures (one-time)...", flush=True)
        failures = scan_for_failures(conn)
        if not failures:
            conn.close()
            return {"error": "No failure signals found in conversations"}
        
        # Filter and prioritize
        priority_order = {"user_correction": 0, "self_correction": 1, "explicit_error": 2}
        failures.sort(key=lambda f: priority_order.get(f["failure_type"], 3))
        
        valuable_failures = []
        for f in failures:
            if f["failure_type"] == "user_correction":
                valuable_failures.append(f)
            elif f["failure_type"] == "self_correction":
                if f["prev_thinking"] and f["tool_call"]:
                    valuable_failures.append(f)
            elif f["failure_type"] == "explicit_error":
                result_lower = f["result"].lower()
                if "exit_code': 141" in result_lower or "sigpipe" in result_lower:
                    continue
                if f["prev_thinking"] and f["tool_call"]:
                    valuable_failures.append(f)
        
        with open(cache_path, "w") as cf:
            json.dump({"valuable_failures": valuable_failures, "total_signals": len(failures)}, cf)
        print(f"Cached {len(valuable_failures)} valuable failures from {len(failures)} total signals", flush=True)
    else:
        with open(cache_path) as cf:
            cache = json.load(cf)
        valuable_failures = cache["valuable_failures"]
    
    # Track progress using a progress file
    progress_path = os.path.join(os.path.dirname(DB_PATH), "failure_progress.txt")
    if os.path.exists(progress_path):
        with open(progress_path) as pf:
            offset = int(pf.read().strip())
    else:
        offset = 0
    
    to_process = valuable_failures[offset:] if offset < len(valuable_failures) else []
    
    if not to_process:
        conn.close()
        return {
            "valuable_failures": len(valuable_failures),
            "processed": 0,
            "patterns_extracted": 0,
            "message": f"All {len(valuable_failures)} valuable failures processed.",
        }
    
    start_time = time.time()
    total_patterns = 0
    skipped = 0
    processed = 0
    
    for f in to_process:
        if time.time() - start_time > max_seconds:
            break
        
        # Format single failure for the prompt
        parts = []
        if f["prev_thinking"]:
            parts.append(f"Thinking before: {f['prev_thinking'][:400]}")
        if f["tool_call"]:
            parts.append(f"Tool call: {f['tool_call']}")
        if f["result"]:
            parts.append(f"Result: {f['result'][:300]}")
        if f["next_thinking"]:
            parts.append(f"Next thinking: {f['next_thinking'][:400]}")
        parts.append(f"Failure type: {f['failure_type']}")
        failure_text = "\n".join(parts)
        
        prompt = FAILURE_EXTRACTION_PROMPT.replace("{failure}", failure_text)
        
        try:
            resp = requests.post(OLLAMA_CHAT_URL, json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.3, "num_ctx": 4096, "keep_alive": "30m"},
            }, timeout=30)
            
            if resp.status_code != 200:
                continue
            
            content = resp.json().get("message", {}).get("content", "")
            if not content:
                continue
            
            # Check for SKIP
            if re.search(r"##\s*SKIP", content, re.IGNORECASE) or content.strip().startswith("SKIP"):
                skipped += 1
                processed += 1
                continue
            
            # Parse anti-pattern
            def extract_section(text, header):
                pattern = rf"##\s*{re.escape(header)}\s*\n(.*?)(?=\n##\s|\Z)"
                match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
                return match.group(1).strip() if match else ""
            
            pattern_text = extract_section(content, "ANTI-PATTERN")
            context = extract_section(content, "CONTEXT")
            recovery = extract_section(content, "RECOVERY")
            
            if not pattern_text or len(pattern_text) < 20:
                skipped += 1
                processed += 1
                continue
            
            # Clean up pattern text (remove leading dashes/asterisks)
            pattern_text = pattern_text.lstrip("- *").strip()
            recovery = recovery.lstrip("- *").strip() if recovery else ""
            
            # Embed for dedup
            fp_emb = None
            try:
                emb_resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [pattern_text]}, timeout=15)
                if emb_resp.status_code == 200:
                    embs = emb_resp.json().get("embeddings", [])
                    if embs:
                        fp_emb = np.array(embs[0], dtype=np.float32)
            except:
                pass
            
            # Check for duplicates against existing patterns
            is_dup = False
            if fp_emb is not None:
                existing = conn.execute("SELECT id, embedding FROM failure_patterns WHERE embedding IS NOT NULL").fetchall()
                for ex in existing:
                    ex_emb = np.frombuffer(ex["embedding"], dtype=np.float32)
                    if len(ex_emb) == len(fp_emb):
                        sim = float(np.dot(fp_emb / (np.linalg.norm(fp_emb) + 1e-8),
                                          ex_emb / (np.linalg.norm(ex_emb) + 1e-8)))
                        if sim > 0.85:
                            conn.execute("UPDATE failure_patterns SET frequency = frequency + 1 WHERE id = ?", (ex["id"],))
                            is_dup = True
                            break
            
            if not is_dup:
                # Store the original failure event as source context
                source_ctx = json.dumps({
                    "conversation_id": f["conversation_id"],
                    "failure_type": f["failure_type"],
                    "thinking_before": f["prev_thinking"][:500] if f["prev_thinking"] else "",
                    "tool_call": f["tool_call"],
                    "result": f["result"][:500] if f["result"] else "",
                    "thinking_after": f["next_thinking"][:500] if f["next_thinking"] else "",
                })
                conn.execute("""
                    INSERT INTO failure_patterns 
                    (pattern_text, context, failure_type, frequency, source_conversations, recovery, embedding, source_context, extracted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    pattern_text,
                    context,
                    f["failure_type"],
                    1,
                    json.dumps([f["conversation_id"]]),
                    recovery,
                    fp_emb.astype(np.float32).tobytes() if fp_emb is not None else None,
                    source_ctx,
                    time.time(),
                ))
                total_patterns += 1
            
            conn.commit()
            processed += 1
            
        except Exception as e:
            conn.rollback()
            continue
    
    elapsed = time.time() - start_time
    conn.close()
    
    # Save progress
    new_offset = offset + processed
    with open(progress_path, "w") as pf:
        pf.write(str(new_offset))
    
    return {
        "valuable_failures": len(valuable_failures),
        "processed": processed,
        "offset": new_offset,
        "patterns_extracted": total_patterns,
        "skipped": skipped,
        "elapsed": round(elapsed, 1),
        "message": f"Processed {processed}/{len(valuable_failures)} (offset {new_offset}): {total_patterns} new patterns, {skipped} skipped, in {elapsed:.1f}s",
    }

# ─── Query Actions ──────────────────────────────────────────────

def list_failure_patterns():
    """List all failure patterns, sorted by frequency."""
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT * FROM failure_patterns ORDER BY frequency DESC, extracted_at DESC
        """).fetchall()
        
        return {
            "patterns": [
                {
                    "id": r["id"],
                    "pattern_text": r["pattern_text"],
                    "context": r["context"],
                    "failure_type": r["failure_type"],
                    "frequency": r["frequency"],
                    "recovery": r["recovery"],
                }
                for r in rows
            ],
            "count": len(rows),
        }
    finally:
        conn.close()

def list_consolidated_skills():
    """List all consolidated skills."""
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT * FROM consolidated_skills ORDER BY reusability DESC, extracted_at DESC
        """).fetchall()
        
        return {
            "skills": [
                {
                    "id": r["id"],
                    "cluster_id": r["cluster_id"],
                    "skill_title": r["skill_title"],
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

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Consolidated skill + failure pattern extraction")
    parser.add_argument("--cluster", action="store_true", help="Run clustering only")
    parser.add_argument("--skills", action="store_true", help="Extract consolidated skills")
    parser.add_argument("--failures", action="store_true", help="Extract failure patterns")
    parser.add_argument("--model", default=DEFAULT_SKILL_MODEL, help="LLM model for extraction")
    parser.add_argument("--list-skills", action="store_true", help="List consolidated skills")
    parser.add_argument("--list-failures", action="store_true", help="List failure patterns")
    args = parser.parse_args()
    
    if args.cluster:
        result = cluster_conversations()
        print(json.dumps(result, indent=2, default=str))
    
    if args.skills:
        result = process_consolidated_skills(model=args.model)
        print(json.dumps(result, indent=2, default=str))
    
    if args.failures:
        result = extract_failure_patterns(model=args.model)
        print(json.dumps(result, indent=2, default=str))
    
    if args.list_skills:
        result = list_consolidated_skills()
        print(f"\n=== Consolidated Skills ({result['count']}) ===")
        for s in result["skills"]:
            print(f"\n[{s['task_type']}/{s['difficulty']}] {s['skill_title']} (reusability={s['reusability']})")
            print(f"  Problem: {s['problem'][:100]}")
            print(f"  Happy path: {s['happy_path'][:200]}...")
            print(f"  Failure patterns: {len(s['failure_patterns'])}")
    
    if args.list_failures:
        result = list_failure_patterns()
        print(f"\n=== Failure Patterns ({result['count']}) ===")
        for p in result["patterns"]:
            print(f"\n  [{p['failure_type']}] (freq={p['frequency']}) {p['pattern_text'][:100]}")
            if p['recovery']:
                print(f"    Recovery: {p['recovery'][:100]}")