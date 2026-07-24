# Conversation Knowledge Base

A Custom App for [Omnideck](https://github.com/omnideck-dev/omnideck) that mines
your stored AI conversation history for three types of value:

1. **Semantic Search** — find past conversations by meaning, not just keywords
2. **Skill Extraction** — extract generalized, reusable "happy paths" from
   conversations using a local LLM
3. **Memory Extraction** *(planned)* — mine conversations for durable facts,
   decisions, and preferences

The app builds a searchable index of your conversation history, then uses an
LLM to extract reusable skills — generalized playbooks with the minimal steps
that worked, pitfalls to avoid, and notes from the experience.

## How It Works

### Search (Phase 1)

The search uses **hybrid semantic + keyword matching**:

- **Semantic search** via [Ollama](https://ollama.com) embeddings
  (`nomic-embed-text` model, 768-dim vectors)
- **Keyword search** via BM25 with title boosting
- Combined score: 40% semantic + 60% keyword
- Results show all matching snippets per conversation, not just the top hit

### Skill Extraction (Phase 2)

Each conversation's compressed trajectory is sent to a local LLM, which:

- Extracts a generalized happy path (with `[placeholder]` variables, not
  specific data from the conversation)
- Identifies pitfalls from failed approaches
- Rates reusability 1–5 and rejects trivial/incomplete conversations
- Deduplicates against existing skills via embedding similarity

## Requirements

### Ollama (required)

The app communicates with an [Ollama](https://ollama.com) instance for both
embeddings and skill extraction. Ollama must be reachable at
`http://localhost:11434` (or update `OLLAMA_URL` / `OLLAMA_CHAT_URL` in
`app.py`).

**Embedding model** (auto-pulled on first run):

```
ollama pull nomic-embed-text
```

**Skill extraction model** (choose one):

| Model | Size | Speed | Quality | Notes |
|-------|------|-------|---------|-------|
| `huihui_ai/qwen3.5-abliterated:35b` | 24 GB | ~17s/conv | Good generalization, follows instructions well | MoE, fast for its size |
| `gpt-oss:120b` | 65 GB | ~66s/conv | Very detailed, full JSON examples | Slow but thorough |
| `gemma3:27b` | 17 GB | ~30s/conv | Decent | |
| `qwen3:8b` | 5 GB | ~20s/conv | Good baseline, concise | Fastest option |

Set the default model in `app.py` (`DEFAULT_SKILL_MODEL`) or pass it via the
UI / CLI.

### Hardware

- **Embeddings**: CPU is fine — `nomic-embed-text` is small and fast. GPU
  optional.
- **Skill extraction**: A GPU is strongly recommended for models ≥ 27B. The
  35B MoE model needs ~24 GB VRAM (fits on a single RTX 3090). The 120B model
  needs ~65 GB VRAM (2× RTX 3090 or equivalent).
- **Storage**: ~15–20 MB for the SQLite database per 100 conversations indexed.

### Software

- Python 3.10+
- `numpy` (vector math)
- `requests` (Ollama API calls)
- `sqlite3` (stdlib — database)
- Omnideck runtime (for Custom App actions)

No CUDA PyTorch installation is needed — all ML inference goes through Ollama.

## Setup

### 1. Install the app

Clone this repo and symlink (or copy) the `conversation-kb` folder into your
Omnideck Custom Apps directory. See the repo-level
[README](../README.md) for installation instructions.

### 2. Build the search index

Run the ingestion script once (outside the app):

```bash
python3 build_index.py
```

This scans your conversation history, compresses each conversation into a
searchable trajectory, generates embeddings via Ollama, and stores everything
in `data/kb.db`. Takes ~30 seconds for ~120 conversations.

Use `--update` to only process new conversations:

```bash
python3 build_index.py --update
```

### 3. Extract skills

From the app UI, click the **Skills** tab → **Extract Skills** button. Or run
from the command line:

```bash
python3 run_extraction.py --model huihui_ai/qwen3.5-abliterated:35b
```

Use `--new-only` to sync the search index first, then only process new
conversations:

```bash
python3 run_extraction.py --new-only
```

### 4. Search from the CLI (for agents)

The `query.py` CLI tool lets agents (and humans) search the knowledge base:

```bash
# Search conversations
python3 query.py "how did I set up the email routine"

# Get full conversation trajectory
python3 query.py --conversation <conversation_id>

# Search with JSON output (for programmatic use)
python3 query.py "fine tune model" --format json --limit 5

# Show stats
python3 query.py --stats

# Sync new conversations
python3 query.py --sync
```

Search results include an `events_path` field pointing to the raw
`events.jsonl` on disk — agents can read that file directly for full,
uncompressed conversation details.

## Architecture

```
conversation-kb/
  omnideck.json          — app manifest
  app.py                 — backend actions (search, skills, sync)
  build_index.py         — one-time ingestion script
  query.py               — CLI search tool (for agents and humans)
  run_extraction.py      — batch skill extraction runner
  web/
    index.html           — single-page app (search + skills tabs)
  data/                  — runtime state (gitignored)
    kb.db                — SQLite: conversations, embeddings, skills
    .gitkeep
```

### SQLite Schema

- `conversations` — metadata + compressed trajectory per conversation
- `search_embeddings` — per-chunk embeddings for semantic search
- `skills` — extracted happy paths, pitfalls, notes
- `skill_embeddings` — per-skill embeddings for dedup and skill search
- `memories` — *(planned)* candidate facts/decisions for promotion

## Keeping It Up to Date

The app detects new and updated conversations by comparing file modification
times. Click the sync indicator in the stats bar, or run:

```bash
python3 query.py --sync          # sync search index
python3 run_extraction.py --new-only  # extract skills for new conversations
```

## License

Copyright 2026 Larry Foulkrod. Licensed under the
[Apache License 2.0](LICENSE).