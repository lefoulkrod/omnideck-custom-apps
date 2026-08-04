const searchInput = document.getElementById('search-input');
        const resultsContainer = document.getElementById('results-container');
        let searchTimer = null;
        let currentView = 'search';
        let lessonSearchTimer = null;
        let currentLessonFilter = '';

        // ─── Global Status ────────────────────────────────────────

        async function loadGlobalStatus() {
            try {
                const stats = await window.omnideck.invoke('get_stats');
                const lessonStats = await window.omnideck.invoke('get_lessons_stats');
                document.getElementById('stat-convs').textContent = stats.total_conversations;
                document.getElementById('stat-chunks').textContent = stats.total_chunks.toLocaleString();
                const byStatus = lessonStats.by_status || {};
                document.getElementById('lessons-count-badge').textContent = byStatus.active ? `(${byStatus.active})` : '';
                document.getElementById('drafts-count-badge').textContent = byStatus.draft ? `(${byStatus.draft})` : '';
                const parts = [`${stats.total_conversations} conversations`, `${stats.total_chunks.toLocaleString()} chunks`];
                if (byStatus.active) parts.push(`${byStatus.active} lessons`);
                if (byStatus.draft) parts.push(`${byStatus.draft} drafts`);
                document.getElementById('stat-summary').textContent = parts.join(' · ');
            } catch (e) {
                document.getElementById('stat-summary').textContent = 'Failed to load stats';
            }
            checkSyncStatus();
        }

        async function checkSyncStatus() {
            try {
                const status = await window.omnideck.invoke('get_sync_status');
                const syncEl = document.getElementById('stat-sync');
                const labelEl = document.getElementById('stat-sync-label');
                if (status.needs_sync) {
                    syncEl.textContent = `${status.new_conversations + status.updated_conversations}`;
                    labelEl.textContent = 'need sync — click';
                } else {
                    syncEl.textContent = '✓';
                    labelEl.textContent = 'up to date';
                }
            } catch (e) {
                document.getElementById('stat-sync').textContent = '?';
                document.getElementById('stat-sync-label').textContent = 'unavailable';
            }
        }

        async function doSync() {
            const syncEl = document.getElementById('stat-sync');
            const labelEl = document.getElementById('stat-sync-label');
            syncEl.textContent = '⟳';
            labelEl.textContent = 'syncing...';
            try {
                const result = await window.omnideck.invoke('sync', { max_seconds: 100 });
                if (result.error) {
                    syncEl.textContent = '!';
                    labelEl.textContent = result.error;
                } else {
                    await loadGlobalStatus();
                    syncEl.textContent = '✓';
                    labelEl.textContent = result.remaining > 0 ? `${result.remaining} remaining` : 'up to date';
                }
            } catch (e) {
                syncEl.textContent = '!';
                labelEl.textContent = 'failed';
            }
        }

        // ─── Search ──────────────────────────────────────────────

        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            const query = e.target.value.trim();
            if (query.length < 3) {
                resultsContainer.innerHTML = '<div class="empty-state"><i class="bi bi-chat-square-text"></i><p>Start typing to search</p></div>';
                return;
            }
            searchTimer = setTimeout(() => doSearch(query), 300);
        });

        async function doSearch(query) {
            currentView = 'search';
            resultsContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Searching...</p></div>';
            try {
                const result = await window.omnideck.invoke('search', { query, limit: 20 });
                if (result.error) { resultsContainer.innerHTML = `<div class="error-msg">${result.error}</div>`; return; }
                if (!result.results || result.results.length === 0) {
                    resultsContainer.innerHTML = `<div class="empty-state"><i class="bi bi-emoji-frown"></i><p>No results for "${query}"</p></div>`;
                    return;
                }
                const filtered = result.results.filter(r => r.score >= 0.10);
                if (filtered.length === 0) {
                    resultsContainer.innerHTML = `<div class="empty-state"><i class="bi bi-emoji-frown"></i><p>No strong matches for "${query}"</p></div>`;
                    return;
                }
                const html = filtered.map(r => {
                    const matches = r.matches.map(m => `
                        <div class="match-snippet" onclick="event.stopPropagation(); viewConversation('${r.conversation_id}')">
                            <span class="match-badge">${m.chunk_type.replace('_', ' ')}</span>
                            <span class="match-score">${(m.score * 100).toFixed(0)}%</span>
                            <div class="match-text">${highlight(m.chunk_text, query)}</div>
                        </div>
                    `).join('');
                    return `
                        <div class="result-card" onclick="viewConversation('${r.conversation_id}')">
                            <div class="result-header">
                                <div>
                                    <div class="result-title">${highlight(r.title, query)}</div>
                                    <div class="result-meta">${r.date} · ${r.match_count} match${r.match_count !== 1 ? 'es' : ''}</div>
                                </div>
                                <div class="result-similarity">${(r.score * 100).toFixed(1)}%</div>
                            </div>
                            <div class="match-list">${matches}</div>
                        </div>`;
                }).join('');
                const hidden = result.results.length - filtered.length;
                resultsContainer.innerHTML = `<div class="results-header">${filtered.length} results${hidden ? ` (${hidden} below threshold)` : ''}</div>${html}`;
            } catch (e) {
                resultsContainer.innerHTML = `<div class="error-msg">Search failed: ${e.message}</div>`;
            }
        }

        async function viewConversation(convId) {
            currentView = 'detail';
            resultsContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading...</p></div>';
            try {
                const conv = await window.omnideck.invoke('get_conversation', { conversation_id: convId, max_trajectory_chars: 15000 });
                if (conv.error) { resultsContainer.innerHTML = `<div class="error-msg">${conv.error}</div>`; return; }
                let traj = esc(conv.trajectory || '');
                traj = traj.replace(/## USER MESSAGE:/g, '<span class="user-msg">## USER MESSAGE:</span>')
                    .replace(/THINKING:/g, '<span class="thinking">THINKING:</span>')
                    .replace(/TOOL_CALL:/g, '<span class="tool-call">TOOL_CALL:</span>')
                    .replace(/RESPONSE:/g, '<span class="response">RESPONSE:</span>')
                    .replace(/RESULT\(/g, '<span class="result">RESULT(');
                const trunc = conv.trajectory_truncated ? `<div class="error-msg" style="margin-bottom:12px;"><i class="bi bi-info-circle"></i> Truncated to 15K chars</div>` : '';
                resultsContainer.innerHTML = `
                    <div class="conversation-detail">
                        <div class="detail-header">
                            <div>
                                <div class="detail-title">${esc(conv.title)}</div>
                                <div class="detail-meta">
                                    <span><i class="bi bi-calendar"></i> ${conv.date}</span>
                                    <span><i class="bi bi-lightning"></i> ${conv.num_tool_calls} tool calls</span>
                                    <span><i class="bi bi-chat"></i> ${conv.num_user_msgs} messages</span>
                                </div>
                            </div>
                            <button class="back-btn" onclick="backToSearch()"><i class="bi bi-arrow-left"></i> Back</button>
                        </div>
                        ${trunc}
                        <div class="trajectory">${traj}</div>
                    </div>`;
            } catch (e) {
                resultsContainer.innerHTML = `<div class="error-msg">Failed: ${e.message}</div>`;
            }
        }

        function backToSearch() {
            currentView = 'search';
            const q = searchInput.value.trim();
            if (q.length >= 3) doSearch(q);
            else resultsContainer.innerHTML = '<div class="empty-state"><i class="bi bi-chat-square-text"></i><p>Start typing to search</p></div>';
        }

        function esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }

        function highlight(text, query) {
            const e = esc(text);
            if (!query || query.length < 2) return e;
            const words = query.toLowerCase().match(/\b\w{3,}\b/g) || [];
            if (!words.length) return e;
            const re = new RegExp('(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
            return e.replace(re, '<mark>$1</mark>');
        }
