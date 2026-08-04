        // ─── Tab Management ───────────────────────────────────────

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('tab-' + tabName).classList.add('active');
            if (tabName === 'lessons') {
                // Default to Active sub-tab
                switchSubTab('active');
            }
        }

        // ─── Sub-Tab Management ──────────────────────────────────

        function switchSubTab(name) {
            document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.subtab-content').forEach(t => t.classList.remove('active'));
            // Find the clicked button
            document.querySelectorAll('.sub-tab').forEach(t => {
                if (t.textContent.includes(name === 'active' ? 'Active' : 'Drafts')) {
                    t.classList.add('active');
                }
            });
            document.getElementById('subtab-' + name).classList.add('active');
            if (name === 'active') loadActiveLessons();
            else loadDrafts();
        }

        // ─── Active Lessons Sub-Tab ───────────────────────────────

        document.getElementById('lesson-search-input').addEventListener('input', (e) => {
            clearTimeout(lessonSearchTimer);
            const q = e.target.value.trim();
            lessonSearchTimer = setTimeout(() => loadActiveLessons(q), 300);
        });

        document.querySelectorAll('#lesson-filters .filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#lesson-filters .filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentLessonFilter = btn.dataset.cat;
                loadActiveLessons(document.getElementById('lesson-search-input').value.trim());
            });
        });

        async function loadActiveLessons(searchQuery) {
            const container = document.getElementById('lessons-container');
            container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading...</p></div>';
            try {
                const data = await window.omnideck.invoke('list_lessons', { status_filter: '' });
                const stats = await window.omnideck.invoke('get_lessons_stats');
                const bs = stats.by_status || {};
                document.getElementById('lesson-process-info').textContent =
                    `${bs.active || 0} active · ${bs.draft || 0} drafts · ${bs.rejected || 0} rejected · ${bs.archived || 0} archived`;
                document.getElementById('active-count-badge').textContent = bs.active ? `(${bs.active})` : '';
                document.getElementById('drafts-count-badge').textContent = bs.draft ? `(${bs.draft})` : '';

                let lessons = data.lessons.filter(l => l.status === 'active');
                if (currentLessonFilter) lessons = lessons.filter(l => l.category === currentLessonFilter);
                if (searchQuery) {
                    const q = searchQuery.toLowerCase();
                    lessons = lessons.filter(l => l.lesson.toLowerCase().includes(q) || (l.context || '').toLowerCase().includes(q));
                }
                if (!lessons.length) {
                    container.innerHTML = '<div class="empty-state"><i class="bi bi-lightbulb"></i><p>No active lessons match</p></div>';
                    return;
                }
                container.innerHTML = lessons.map(l => lessonCard(l)).join('');
            } catch (e) {
                container.innerHTML = `<div class="error-msg">${e.message}</div>`;
            }
        }

        // ─── Drafts Sub-Tab ───────────────────────────────────────

        async function loadDrafts() {
            const container = document.getElementById('drafts-container');
            container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading...</p></div>';
            try {
                const data = await window.omnideck.invoke('list_lessons', { status_filter: 'draft' });
                const count = data.count;
                const info = document.getElementById('lesson-process-info');
                info.innerHTML = `${count} drafts to review` +
                    (count > 0 ? ` · <button class="skill-btn" onclick="deleteAllDrafts()" style="font-size:0.75rem;border-color:var(--danger);color:var(--danger);">🗑️ Delete All</button>` : '');
                if (!data.lessons.length) {
                    container.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>No drafts to review</p></div>';
                    return;
                }
                container.innerHTML = data.lessons.map(l => lessonCard(l)).join('');
            } catch (e) {
                container.innerHTML = `<div class="error-msg">${e.message}</div>`;
            }
        }

        async function deleteAllDrafts() {
            const count = document.querySelector('#lesson-process-info').textContent.match(/\d+/)?.[0] || 0;
            if (!confirm('Delete all ' + count + ' drafts? (They\'re duplicates, not bad lessons)')) return;
            try {
                const data = await window.omnideck.invoke('list_lessons', { status_filter: 'draft' });
                for (const l of data.lessons) {
                    await window.omnideck.invoke('delete_lesson', { lesson_id: l.id });
                }
                loadDrafts();
                loadGlobalStatus();
            } catch (e) {
                console.error(e);
            }
        }

        // ─── Lesson Card ──────────────────────────────────────────

        function lessonCard(l) {
            const catColors = { technical_approach: 'badge-research', workflow: 'badge-configure', debugging: 'badge-debug', tool_usage: 'badge-qa', environment: 'badge-other' };
            const catClass = catColors[l.category] || 'badge-other';
            const stars = '★'.repeat(l.importance) + '☆'.repeat(5 - l.importance);
            const sc = {
                draft: { border: 'var(--text-muted)', opacity: '0.6', badge: 'DRAFT', bs: 'border-color:var(--warning);color:var(--warning);' },
                active: { border: 'var(--accent)', opacity: '1', badge: '', bs: '' },
                rejected: { border: 'var(--danger)', opacity: '0.5', badge: 'REJECTED', bs: 'border-color:var(--danger);color:var(--danger);' },
                archived: { border: 'var(--text-muted)', opacity: '0.5', badge: 'ARCHIVED', bs: 'border-color:var(--text-muted);color:var(--text-muted);' },
            }[l.status] || sc.draft;

            let actions = '';
            if (l.status === 'draft') actions = `
                <button class="skill-btn" onclick="setStatus(${l.id},'active')" style="font-size:0.75rem;border-color:var(--success);color:var(--success);">✅ Activate</button>
                <button class="skill-btn" onclick="setStatus(${l.id},'rejected')" style="font-size:0.75rem;border-color:var(--danger);color:var(--danger);">❌ Reject</button>`;
            else if (l.status === 'active') actions = `<button class="skill-btn" onclick="setStatus(${l.id},'archived')" style="font-size:0.75rem;">🙈 Archive</button>`;
            else if (l.status === 'rejected') actions = `
                <button class="skill-btn" onclick="setStatus(${l.id},'draft')" style="font-size:0.75rem;">📌 Restore as Draft</button>
                <button class="skill-btn" onclick="delLesson(${l.id})" style="font-size:0.75rem;color:var(--danger);border-color:var(--danger);">🗑️ Delete</button>`;
            else if (l.status === 'archived') actions = `
                <button class="skill-btn" onclick="setStatus(${l.id},'active')" style="font-size:0.75rem;">📌 Restore</button>
                <button class="skill-btn" onclick="delLesson(${l.id})" style="font-size:0.75rem;color:var(--danger);border-color:var(--danger);">🗑️ Delete</button>`;

            return `
                <div class="failure-card" style="border-left-color:${sc.border};opacity:${sc.opacity};">
                    <div class="failure-meta">
                        <span class="failure-badge ${catClass}">${l.category}</span>
                        <span class="failure-badge badge-freq" title="Importance 1-5">${stars}</span>
                        ${sc.badge ? `<span class="failure-badge badge-freq" style="${sc.bs}">${sc.badge}</span>` : ''}
                    </div>
                    <div class="failure-pattern-text">${esc(l.lesson)}</div>
                    ${l.context ? `<div class="skill-source" style="margin-top:6px;">📎 ${esc(l.context)}</div>` : ''}
                    <div style="margin-top:10px;display:flex;gap:6px;">${actions}</div>
                </div>`;
        }

        async function setStatus(id, status) {
            try {
                await window.omnideck.invoke('update_lesson', { lesson_id: id, status: status });
                // Reload the current sub-tab
                const activeSub = document.querySelector('.subtab-content.active');
                if (activeSub && activeSub.id === 'subtab-drafts') loadDrafts();
                else loadActiveLessons(document.getElementById('lesson-search-input').value.trim());
                loadGlobalStatus();
            } catch (e) { console.error(e); }
        }

        async function delLesson(id) {
            if (!confirm('Delete this lesson?')) return;
            try {
                await window.omnideck.invoke('delete_lesson', { lesson_id: id });
                const activeSub = document.querySelector('.subtab-content.active');
                if (activeSub && activeSub.id === 'subtab-drafts') loadDrafts();
                else loadActiveLessons(document.getElementById('lesson-search-input').value.trim());
                loadGlobalStatus();
            } catch (e) { console.error(e); }
        }

        // ─── Extraction ───────────────────────────────────────────

        async function extractLessons() {
            const btn = document.getElementById('extract-lessons-btn');
            const info = document.getElementById('lesson-process-info');
            btn.disabled = true;
            btn.textContent = '⟳ Extracting...';
            info.textContent = 'Scanning conversations...';
            try {
                const result = await window.omnideck.invoke('extract_lessons', { max_seconds: 100 });
                if (result.error) info.textContent = 'Error: ' + result.error;
                else info.textContent = result.message;
                loadGlobalStatus();
                // Reload current sub-tab
                const activeSub = document.querySelector('.subtab-content.active');
                if (activeSub && activeSub.id === 'subtab-drafts') loadDrafts();
                else loadActiveLessons(document.getElementById('lesson-search-input').value.trim());
            } catch (e) {
                info.textContent = 'Failed: ' + e.message;
            } finally {
                btn.disabled = false;
                btn.textContent = '🔄 Re-extract Lessons';
            }
        }

        // ─── Init ─────────────────────────────────────────────────

        loadGlobalStatus();
        searchInput.focus();
