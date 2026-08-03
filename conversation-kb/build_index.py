#!/usr/bin/env python3
"""
build_index.py — One-time ingestion script for the Conversation Knowledge Base.

Parses all stored conversations, compresses them, generates embeddings via Ollama,
and stores everything in SQLite. Run this before using the app.

Usage:
    python3 build_index.py           # Full rebuild
    python3 build_index.py --update   # Only process new conversations
"""

import json
import os
import re
import sqlite3
import time
import sys
import requests
import struct
import numpy as np
from datetime import datetime

CONV_DIR = "/var/lib/omnideck/conversations"
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kb.db")
OLLAMA_URL = "http://localhost:11434/api/embed"
EMBED_MODEL = "qwen3-embedding:8b"
EMBED_DIM = 4096

# ─── Database Setup ───────────────────────────────────────────────

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        date TEXT,
        num_events INTEGER,
        num_tool_calls INTEGER,
        num_user_msgs INTEGER,
        compressed_trajectory TEXT,
        est_tokens INTEGER,
        processed_search INTEGER DEFAULT 0,
        processed_skill INTEGER DEFAULT 0,
        processed_memory INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS search_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        chunk_type TEXT,
        chunk_index INTEGER,
        chunk_text TEXT,
        embedding BLOB,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    
    CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        model TEXT,
        skill_title TEXT,
        problem TEXT,
        happy_path TEXT,
        pitfalls TEXT,
        notes TEXT,
        task_type TEXT,
        difficulty TEXT,
        extracted_at TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        memory_type TEXT,
        content TEXT,
        confidence REAL,
        source_context TEXT,
        status TEXT DEFAULT 'candidate',
        extracted_at TEXT,
        promoted_at TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_search_conv ON search_embeddings(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conv_date ON conversations(date);
    """)
    
    conn.commit()
    return conn

# ─── Conversation Parsing ────────────────────────────────────────

def load_conversations():
    """Scan the conversations directory and return all conversation IDs with events."""
    convs = []
    for d in sorted(os.listdir(CONV_DIR)):
        if d.startswith("_") or d == "routines":
            continue
        events_path = os.path.join(CONV_DIR, d, "events.jsonl")
        if not os.path.exists(events_path):
            continue
        convs.append(d)
    return convs

def load_events(conv_id):
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

def load_title(conv_id):
    """Load conversation title from metadata.json."""
    meta_path = os.path.join(CONV_DIR, conv_id, "metadata.json")
    if os.path.exists(meta_path):
        try:
            return json.load(open(meta_path)).get("title", "(no title)")
        except:
            pass
    return "(no title)"

def get_conversation_date(events):
    """Get the date of the first event."""
    for evt in events:
        ts = evt.get("timestamp", "")
        if ts:
            return ts[:10]  # YYYY-MM-DD
    return "unknown"

def compress_tool_result(content, max_chars=300):
    """Compress a tool result to a status line + preview."""
    if not content:
        return "(empty result)"
    
    content_lower = content.lower()
    status_parts = []
    
    m = re.search(r"'exit_code':\s*(\d+)", content)
    if m:
        code = int(m.group(1))
        status_parts.append(f"exit={code}({'success' if code == 0 else 'FAILED'})")
    
    error_words = ["traceback", "exception", "permission denied", "no such file", "does not exist"]
    if any(w in content_lower for w in error_words):
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

def build_compressed_trajectory(events, title):
    """Build a compressed trajectory text from events."""
    lines = []
    lines.append(f"# Conversation: {title}")
    lines.append(f"# Total events: {len(events)}")
    lines.append("")
    
    step_num = 0
    
    for evt in events:
        etype = evt.get("type")
        
        if etype == "user_message":
            content = evt.get("content") or ""
            lines.append(f"\n## USER MESSAGE:")
            lines.append(content[:2000])
            lines.append("")
        
        elif etype == "iteration":
            step_num += 1
            thinking = evt.get("thinking") or ""
            content = evt.get("content") or ""
            tool_calls = evt.get("tool_calls") or []
            
            lines.append(f"\n### Step {step_num}:")
            if thinking:
                lines.append(f"THINKING: {thinking[:1000]}")
            
            for tc in tool_calls:
                tool_name = tc.get("name", "?")
                args = tc.get("arguments", {})
                key_args = {}
                for k in ["cmd", "path", "url", "query", "pattern", "name", "selector", "code", "instructions"]:
                    if k in args:
                        val = str(args[k])
                        key_args[k] = val[:150]
                args_str = json.dumps(key_args) if key_args else "{}"
                lines.append(f"  TOOL_CALL: {tool_name}({args_str})")
            
            if content:
                lines.append(f"RESPONSE: {content[:2000]}")
        
        elif etype == "tool_result":
            content = evt.get("content") or ""
            tool_name = evt.get("tool_name", "?")
            compressed = compress_tool_result(content)
            lines.append(f"  RESULT({tool_name}): {compressed}")
    
    return "\n".join(lines)

def extract_search_chunks(events, title):
    """Extract searchable text chunks from a conversation.
    
    Returns list of (chunk_type, chunk_index, chunk_text) tuples.
    """
    chunks = []
    
    # Conversation-level summary chunk
    user_msgs = [e for e in events if e.get("type") == "user_message"]
    if user_msgs:
        summary = f"Conversation: {title}\n"
        summary += f"First message: {(user_msgs[0].get('content') or '')[:500]}"
        chunks.append(("summary", 0, summary))
    
    # Individual user messages
    msg_idx = 0
    for evt in events:
        if evt.get("type") == "user_message":
            content = (evt.get("content") or "").strip()
            if content and len(content) > 10:  # Skip very short messages
                chunks.append(("user_message", msg_idx, content[:1000]))
                msg_idx += 1
    
    # Agent responses (the content field from iterations)
    resp_idx = 0
    for evt in events:
        if evt.get("type") == "iteration":
            content = (evt.get("content") or "").strip()
            if content and len(content) > 50:  # Skip very short responses
                chunks.append(("agent_response", resp_idx, content[:1500]))
                resp_idx += 1
    
    return chunks

# ─── Embedding Generation ────────────────────────────────────────

def embed_texts(texts, batch_size=20):
    """Generate embeddings for a list of texts using Ollama."""
    all_embeddings = []
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        
        response = requests.post(OLLAMA_URL, json={
            "model": EMBED_MODEL,
            "input": batch,
        }, timeout=60)
        
        if response.status_code != 200:
            print(f"  Warning: embedding API returned {response.status_code}")
            # Return zero vectors as fallback
            for _ in batch:
                all_embeddings.append(np.zeros(EMBED_DIM, dtype=np.float32))
            continue
        
        data = response.json()
        for emb in data.get("embeddings", []):
            all_embeddings.append(np.array(emb, dtype=np.float32))
        
        if (i // batch_size) % 10 == 0 and i > 0:
            print(f"  Embedded {i + len(batch)}/{len(texts)} chunks...")
    
    return all_embeddings

def embed_to_blob(emb):
    """Convert numpy embedding to bytes for SQLite storage."""
    return emb.astype(np.float32).tobytes()

def blob_to_embed(blob):
    """Convert SQLite blob back to numpy embedding."""
    return np.frombuffer(blob, dtype=np.float32)

# ─── Main Ingestion ──────────────────────────────────────────────

def ingest_conversation(conn, conv_id, skip_existing=False):
    """Ingest a single conversation: parse, compress, embed, store."""
    # Check if already processed
    if skip_existing:
        existing = conn.execute(
            "SELECT id FROM conversations WHERE id = ? AND processed_search = 1",
            (conv_id,)
        ).fetchone()
        if existing:
            return False  # Already processed
    
    events = load_events(conv_id)
    if not events:
        return False
    
    title = load_title(conv_id)
    date = get_conversation_date(events)
    
    # Count stats
    num_events = len(events)
    num_tool_calls = sum(len(e.get("tool_calls") or []) for e in events if e.get("type") == "iteration")
    num_user_msgs = sum(1 for e in events if e.get("type") == "user_message")
    
    # Build compressed trajectory
    trajectory = build_compressed_trajectory(events, title)
    est_tokens = len(trajectory) // 4
    
    # Store conversation
    conn.execute("""
        INSERT OR REPLACE INTO conversations 
        (id, title, date, num_events, num_tool_calls, num_user_msgs, 
         compressed_trajectory, est_tokens, processed_search)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    """, (conv_id, title, date, num_events, num_tool_calls, num_user_msgs,
          trajectory, est_tokens))
    
    # Extract search chunks
    chunks = extract_search_chunks(events, title)
    
    if not chunks:
        conn.execute("UPDATE conversations SET processed_search = 1 WHERE id = ?", (conv_id,))
        conn.commit()
        return True
    
    # Generate embeddings
    chunk_texts = [c[2] for c in chunks]
    embeddings = embed_texts(chunk_texts)
    
    # Store embeddings
    # Clear old embeddings for this conversation
    conn.execute("DELETE FROM search_embeddings WHERE conversation_id = ?", (conv_id,))
    
    for (chunk_type, chunk_index, chunk_text), emb in zip(chunks, embeddings):
        conn.execute("""
            INSERT INTO search_embeddings 
            (conversation_id, chunk_type, chunk_index, chunk_text, embedding)
            VALUES (?, ?, ?, ?, ?)
        """, (conv_id, chunk_type, chunk_index, chunk_text, embed_to_blob(emb)))
    
    # Mark as processed
    conn.execute("UPDATE conversations SET processed_search = 1 WHERE id = ?", (conv_id,))
    conn.commit()
    
    return True

def main():
    update_only = "--update" in sys.argv
    
    print("=" * 60)
    print("Conversation Knowledge Base — Index Builder")
    print("=" * 60)
    
    conn = init_db()
    
    conv_ids = load_conversations()
    print(f"\nFound {len(conv_ids)} conversations")
    
    if update_only:
        # Only process conversations not yet in the DB
        existing = set(r[0] for r in conn.execute("SELECT id FROM conversations").fetchall())
        conv_ids = [c for c in conv_ids if c not in existing]
        print(f"After filtering existing: {len(conv_ids)} new conversations to process")
    
    if not conv_ids:
        print("Nothing to do.")
        return
    
    # Check Ollama is running
    try:
        requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": "test"}, timeout=10)
    except Exception as e:
        print(f"ERROR: Cannot reach Ollama at {OLLAMA_URL}: {e}")
        return
    
    print(f"Using embedding model: {EMBED_MODEL} ({EMBED_DIM} dims)")
    print()
    
    total_chunks = 0
    start_time = time.time()
    
    for i, conv_id in enumerate(conv_ids):
        title = load_title(conv_id)
        print(f"[{i+1}/{len(conv_ids)}] {conv_id[:8]} — {title}")
        
        try:
            processed = ingest_conversation(conn, conv_id, skip_existing=update_only)
            if processed:
                chunk_count = conn.execute(
                    "SELECT COUNT(*) FROM search_embeddings WHERE conversation_id = ?",
                    (conv_id,)
                ).fetchone()[0]
                total_chunks += chunk_count
                print(f"  → {chunk_count} chunks embedded")
            else:
                print(f"  → skipped (already processed)")
        except Exception as e:
            print(f"  → ERROR: {e}")
    
    elapsed = time.time() - start_time
    
    # Print stats
    total_convs = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    total_embeds = conn.execute("SELECT COUNT(*) FROM search_embeddings").fetchone()[0]
    processed = conn.execute("SELECT COUNT(*) FROM conversations WHERE processed_search = 1").fetchone()[0]
    
    print(f"\n{'=' * 60}")
    print(f"Done in {elapsed:.1f}s")
    print(f"  Conversations: {total_convs} ({processed} processed)")
    print(f"  Search chunks: {total_embeds}")
    print(f"  DB size: {os.path.getsize(DB_PATH) / 1024 / 1024:.1f} MB")
    print(f"  DB path: {DB_PATH}")

if __name__ == "__main__":
    main()