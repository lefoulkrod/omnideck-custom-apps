import os
import time
import numpy as np
import sqlite3

INDEX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
EMEDDINGS_PATH = os.path.join(INDEX_DIR, "kb_embeddings.npy")
IDS_PATH = os.path.join(INDEX_DIR, "kb_embedding_ids.npy")
META_PATH = os.path.join(INDEX_DIR, "kb_index_meta.txt")


class KBSearchIndex:
    """Fast numpy-based embedding index for the Conversation KB."""

    def __init__(self):
        self.embeddings: np.nddary | None = None
        self.chunk_ids: np.nddary | None = None
        self._norm_embeddings: np.nddary | None = None

    def exists(self) -> bool:
        return os.path.exists(EMEDDINGS_PATH) and os.path.exists(IDS_PATH)

    def _count_indexed_chunks(self, conn: sqlite3.Connection) -> int:
        return conn.execute("SELECT COUNT(*) FROM search_embeddings").fetchone()[0]

    def build_if_needed(self.