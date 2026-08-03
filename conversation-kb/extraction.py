"""
extraction.py -- Consolidated skill extraction + failure pattern extraction.

Uses HDBSCAN clustering to group similar conversations, then sends each cluster
to an LLM for ONE consolidated skill with failure workarounds.
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
