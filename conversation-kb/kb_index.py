"""
kb_index.py — Fast numpy-based embedding index for the Conversation KB.

Stores all search embeddings in a flat .npy file for fast cosine similarity
lookup, avoiding the 2-second SQLite load of all rows on every query.

Usage:
    from kb_index import KBSearchIndex
    index = KBSearchIndex()
    index.build(conn)          # rebuild from SQLite
    index.build_if_needed(conn)  # rebuild only if index is stale
    chunk_ids, scores = index.search(query_emb, top_k=200)
"""

import os
import time
import numpy as np
import sqlite3

INDEX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
EMBEDDINGS_PATH = os.path.join(INDEX_DIR, "kb_embeddings.npy")
IDS_PATH = os.path.join(INDEX_DIR, "kb_embedding_ids.npy")
META_PATH = os.path.join(INDEX_DIR, "kb_index_meta.txt")


class KBSearchIndex:
    """Fast numpy-based embedding index for ANN-style candidate retrieval."""

    def __init__(self):
        self.embeddings: np.ndarray | None = None
        self.chunk_ids: np.ndarray | None = None
        self._norm_embeddings: np.ndarray | None = None

    def exists(self) -> bool:
        return os.path.exists(EMBEDDINGS_PATH) and os.path.exists(IDS_PATH)

    def _count_indexed_chunks(self, conn: sqlite3.Connection) -> int:
        return conn.execute("SELECT COUNT(*) FROM search_embeddings").fetchone()[0]

    def build_if_needed(self, conn: sqlite3.Connection) -> bool:
        """Rebuild the index if the chunk count has changed since last build.
        Returns True if rebuilt, False if already current."""
        db_count = self._count_indexed_chunks(conn)
        meta_count = self._load_meta_count()

        if self.exists() and meta_count == db_count:
            # Index is current — just load it
            self.load()
            return False

        self.build(conn)
        return True

    def build(self, conn: sqlite3.Connection):
        """Build the index from all search_embeddings in the database."""
        rows = conn.execute(
            "SELECT id, embedding FROM search_embeddings ORDER BY id"
        ).fetchall()

        if not rows:
            self.embeddings = np.empty((0, 0), dtype=np.float32)
            self.chunk_ids = np.array([], dtype=np.int64)
            self._norm_embeddings = None
            self._save_meta(0)
            return

        chunk_ids = np.array([r["id"] for r in rows], dtype=np.int64)
        embeddings = np.array(
            [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows],
            dtype=np.float32,
        )

        self.embeddings = embeddings
        self.chunk_ids = chunk_ids
        self._precompute_norms()

        # Save to disk
        np.save(EMBEDDINGS_PATH, embeddings)
        np.save(IDS_PATH, chunk_ids)
        self._save_meta(len(rows))

    def load(self):
        """Load the index from disk."""
        self.embeddings = np.load(EMBEDDINGS_PATH, mmap_mode=None)
        self.chunk_ids = np.load(IDS_PATH)
        self._precompute_norms()

    def _precompute_norms(self):
        """Precompute normalized embeddings for fast cosine similarity."""
        norms = np.linalg.norm(self.embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1  # avoid division by zero
        self._norm_embeddings = self.embeddings / norms

    def search(self, query_emb: np.ndarray, top_k: int = 200) -> tuple[list[int], list[float]]:
        """Return (chunk_ids, cosine_similarities) for top-K matches.
        
        Uses precomputed normalized embeddings for fast dot-product similarity.
        """
        if self.embeddings is None or len(self.embeddings) == 0:
            return [], []

        query_norm = query_emb / (np.linalg.norm(query_emb) + 1e-8)
        sims = np.dot(self._norm_embeddings, query_norm)

        # Get top-K indices
        k = min(top_k, len(sims))
        top_indices = np.argpartition(sims, -k)[-k:]
        # Sort by similarity descending
        top_indices = top_indices[np.argsort(sims[top_indices])[::-1]]

        return (
            self.chunk_ids[top_indices].tolist(),
            sims[top_indices].tolist(),
        )

    def _save_meta(self, count: int):
        with open(META_PATH, "w") as f:
            f.write(str(count))

    def _load_meta_count(self) -> int:
        try:
            with open(META_PATH) as f:
                return int(f.read().strip())
        except (FileNotFoundError, ValueError):
            return -1

    def invalidate(self):
        """Delete the on-disk index so it gets rebuilt on next search."""
        for path in [EMBEDDINGS_PATH, IDS_PATH, META_PATH]:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        self.embeddings = None
        self.chunk_ids = None
        self._norm_embeddings = None
