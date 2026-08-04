/**
 * Unified Hub — Frontend Logic
 *
 * Tabbed interface for calendar and email across all connected integrations.
 * Communicates with the Python backend via the Omnideck app SDK.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────

  const state = {
    integrations: {},
    calendars: {},      // { integration_id: [{name, url}] }
    currentEmailList: [],
    selectedMessage: null,
    selectedEmailIntegration: '',
    selectedEmailFolder: 'INBOX',
  };

  // ─── Helpers ────────────────────────────────────────────────────

  async function invoke(action, args = {}) {
    return await window.omnideck.invoke(action, args);
  }

  function showLoading(text = 'Loading…') {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').classList.remove('hidden');
  }

  function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }

  function showError(msg) {
    const banner = document.getElementById('errorBanner');
    document.getElementById('errorText').textContent = msg;
    banner.style.display = 'flex';
    setTimeout(() => { banner.style.display = 'none'; }, 5000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return iso; }
  }

  function formatDateShort(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return iso; }
  }

  function integrationBadge(iid) {
    const isGoogle = iid.includes('google');
    const cls = isGoogle ? 'badge-google' : 'badge-icloud';
    const label = isGoogle ? 'Google' : 'iCloud';
    return `<span class="integration-badge ${cls}">${label}</span>`;
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // ─── Tab Navigation ─────────────────────────────────────────────

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ─── Modal Helpers ──────────────────────────────────────────────

  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.modal).style.display = 'none';
    });
  });

  // ─── Dashboard ──────────────────────────────────────────────────

  async function loadDashboard() {
    showLoading('Loading dashboard…');
    try {
      const result = await invoke('get_dashboard');
      renderDashboardEvents(result.events || {});
      renderDashboardMessages(result.messages || {});
      state.integrations = result.integrations || {};
    } catch (err) {
      showError('Failed to load dashboard: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function renderDashboardEvents(eventsByIntegration) {
    const container = document.getElementById('dashboardEvents');
    const allEvents = [];

    for (const [iid, data] of Object.entries(eventsByIntegration)) {
      if (data.ok && data.result && data.result.events) {
        for (const ev of data.result.events) {
          allEvents.push({ ...ev, integration_id: iid, label: data.label });
        }
      }
    }

    allEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    if (allEvents.length === 0) {
      container.innerHTML = '<div class="empty-state">No upcoming events</div>';
      return;
    }

    container.innerHTML = allEvents.map(ev => `
      <div class="event-card">
        <div class="event-title">${escapeHtml(ev.summary || '(No title)')}</div>
        <div class="event-time">${formatDate(ev.start)}</div>
        ${ev.location ? `<div class="event-location">📍 ${escapeHtml(ev.location)}</div>` : ''}
        <div class="event-source">${integrationBadge(ev.integration_id)}</div>
      </div>
    `).join('');
  }

  function renderDashboardMessages(messagesByIntegration) {
    const container = document.getElementById('dashboardMessages');
    const allMsgs = [];

    for (const [iid, data] of Object.entries(messagesByIntegration)) {
      if (data.ok && data.result && data.result.headers) {
        for (const h of data.result.headers) {
          allMsgs.push({ ...h, integration_id: iid, label: data.label });
        }
      }
    }

    if (allMsgs.length === 0) {
      container.innerHTML = '<div class="empty-state">No recent emails</div>';
      return;
    }

    container.innerHTML = allMsgs.map(msg => `
      <div class="email-card" data-iid="${msg.integration_id}" data-uid="${msg.uid}" data-folder="${msg.folder || 'INBOX'}">
        <div class="email-subject">${escapeHtml(truncate(msg.subject || '(No subject)', 50))}</div>
        <div class="email-from">${escapeHtml(msg.from_ || '')}</div>
        <div class="email-date">${formatDateShort(msg.date)}</div>
        <div class="email-source">${integrationBadge(msg.integration_id)}</div>
      </div>
    `).join('');

    // Click to open in email tab
    container.querySelectorAll('.email-card').forEach(card => {
      card.addEventListener('click', () => {
        const iid = card.dataset.iid;
        const uid = card.dataset.uid;
        const folder = card.dataset.folder;
        // Switch to email tab and open the message
        document.querySelector('.tab-btn[data-tab="email"]').click();
        openMessage(iid, folder, uid);
      });
    });
  }

  // ─── Calendar Tab ────────────────────────────────────────────────

  async function initCalendarTab() {
    const select = document.getElementById('calIntegrationSelect');
    const calIids = Object.entries(state.integrations).filter(([iid, _]) => {
      // Only show integrations that have calendar capability
      return true; // We'll filter after loading
    });

    // Load integrations if not already loaded
    if (Object.keys(state.integrations).length === 0) {
      try {
        const result = await invoke('get_integrations');
        state.integrations = result;
      } catch (err) {
        showError('Failed to load integrations: ' + err.message);
        return;
      }
    }

    select.innerHTML = '<option value="">Select integration…</option>';
    for (const [iid, info] of Object.entries(state.integrations)) {
      if (info.capabilities && info.capabilities.includes('calendar')) {
        select.innerHTML += `<option value="${iid}">${escapeHtml(info.label)}</option>`;
      }
    }
  }

  document.getElementById('calIntegrationSelect').addEventListener('change', async (e) => {
    const iid = e.target.value;
    const calSelect = document.getElementById('calCalendarSelect');
    if (!iid) {
      calSelect.disabled = true;
      calSelect.innerHTML = '<option value="">Select a calendar…</option>';
      return;
    }

    showLoading('Loading calendars…');
    try {
      const result = await invoke('list_calendars', { integration_id: iid });
      const data = result[iid];
      if (data && data.ok) {
        state.calendars[iid] = data.result.calendars || [];
        calSelect.innerHTML = '<option value="primary">Primary (default)</option>';
        for (const cal of state.calendars[iid]) {
          calSelect.innerHTML += `<option value="${escapeHtml(cal.url)}">${escapeHtml(cal.name)}</option>`;
        }
        calSelect.disabled = false;
      } else {
        showError(data ? data.error : 'Failed to load calendars');
        calSelect.innerHTML = '<option value="">Select a calendar…</option>';
        calSelect.disabled = true;
      }
    } catch (err) {
      showError('Failed to load calendars: ' + err.message);
    } finally {
      hideLoading();
    }
  });

  document.getElementById('calLoadBtn').addEventListener('click', async () => {
    const iid = document.getElementById('calIntegrationSelect').value;
    const calUrl = document.getElementById('calCalendarSelect').value;
    const daysForward = parseInt(document.getElementById('calDaysForward').value) || 30;

    if (!iid || !calUrl) {
      showError('Please select an integration and calendar');
      return;
    }

    showLoading('Loading events…');
    try {
      const result = await invoke('list_events', {
        integration_id: iid,
        calendar_url: calUrl,
        days_forward: daysForward,
        days_back: 0,
        limit: 50,
      });

      const container = document.getElementById('calendarEvents');
      if (result.ok && result.result && result.result.events) {
        const events = result.result.events;
        if (events.length === 0) {
          container.innerHTML = '<div class="empty-state">No events found</div>';
        } else {
          container.innerHTML = events.map(ev => `
            <div class="event-card">
              <div class="event-title">${escapeHtml(ev.summary || '(No title)')}</div>
              <div class="event-time">${formatDate(ev.start)} → ${formatDate(ev.end)}</div>
              ${ev.location ? `<div class="event-location">📍 ${escapeHtml(ev.location)}</div>` : ''}
              <div class="event-source">${integrationBadge(iid)}</div>
            </div>
          `).join('');
        }
      } else {
        container.innerHTML = `<div class="error-state">${escapeHtml(result.error || 'Failed to load events')}</div>`;
      }
    } catch (err) {
      showError('Failed to load events: ' + err.message);
    } finally {
      hideLoading();
    }
  });

  document.getElementById('calCreateBtn').addEventListener('click', async () => {
    // Populate integration select
    const select = document.getElementById('eventIntegration');
    select.innerHTML = '';
    for (const [iid, info] of Object.entries(state.integrations)) {
      if (info.capabilities && info.capabilities.includes('calendar')) {
        select.innerHTML += `<option value="${iid}">${escapeHtml(info.label)}</option>`;
      }
    }
    // Trigger calendar load for the first integration
    if (select.options.length > 0) {
      select.dispatchEvent(new Event('change'));
    }
    document.getElementById('createEventModal').style.display = 'flex';
  });

  document.getElementById('eventIntegration').addEventListener('change', async (e) => {
    const iid = e.target.value;
    const calSelect = document.getElementById('eventCalendar');
    if (!iid) return;

    try {
      const result = await invoke('list_calendars', { integration_id: iid });
      const data = result[iid];
      if (data && data.ok) {
        calSelect.innerHTML = '<option value="primary">Primary (default)</option>';
        for (const cal of (data.result.calendars || [])) {
          calSelect.innerHTML += `<option value="${escapeHtml(cal.url)}">${escapeHtml(cal.name)}</option>`;
        }
      }
    } catch (err) {
      console.error('Failed to load calendars for event form:', err);
    }
  });

  document.getElementById('eventCreateBtn').addEventListener('click', async () => {
    const iid = document.getElementById('eventIntegration').value;
    const calId = document.getElementById('eventCalendar').value;
    const summary = document.getElementById('eventSummary').value;
    const startVal = document.getElementById('eventStart').value;
    const endVal = document.getElementById('eventEnd').value;
    const location = document.getElementById('eventLocation').value;
    const description = document.getElementById('eventDescription').value;

    if (!iid || !calId || !summary || !startVal || !endVal) {
      showError('Please fill in integration, calendar, title, start, and end');
      return;
    }

    // Convert datetime-local to RFC 3339
    const start = new Date(startVal).toISOString();
    const end = new Date(endVal).toISOString();

    showLoading('Creating event…');
    try {
      const result = await invoke('create_event', {
        integration_id: iid,
        calendar_id: calId,
        summary,
        start,
        end,
        description,
        location,
      });
      if (result.ok) {
        document.getElementById('createEventModal').style.display = 'none';
        // Clear form
        document.getElementById('eventSummary').value = '';
        document.getElementById('eventStart').value = '';
        document.getElementById('eventEnd').value = '';
        document.getElementById('eventLocation').value = '';
        document.getElementById('eventDescription').value = '';
        showError('Event created successfully!');
        // Reload events if calendar tab is active
        document.getElementById('calLoadBtn').click();
      } else {
        showError('Failed to create event: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      showError('Failed to create event: ' + err.message);
    } finally {
      hideLoading();
    }
  });

  // ─── Email Tab ───────────────────────────────────────────────────

  async function initEmailTab() {
    // Load integrations if not already loaded
    if (Object.keys(state.integrations).length === 0) {
      try {
        const result = await invoke('get_integrations');
        state.integrations = result;
      } catch (err) {
        showError('Failed to load integrations: ' + err.message);
        return;
      }
    }

    const select = document.getElementById('emailIntegrationSelect');
    select.innerHTML = '<option value="">Select…</option>';
    for (const [iid, info] of Object.entries(state.integrations)) {
      if (info.capabilities && info.capabilities.includes('email')) {
        select.innerHTML += `<option value="${iid}">${escapeHtml(info.label)}</option>`;
      }
    }

    // Populate compose integration select
    const composeSelect = document.getElementById('composeIntegration');
    composeSelect.innerHTML = '';
    for (const [iid, info] of Object.entries(state.integrations)) {
      if (info.capabilities && info.capabilities.includes('email')) {
        composeSelect.innerHTML += `<option value="${iid}">${escapeHtml(info.label)}</option>`;
      }
    }
  }

  document.getElementById('emailIntegrationSelect').addEventListener('change', async (e) => {
    const iid = e.target.value;
    state.selectedEmailIntegration = iid;
    if (!iid) return;

    // Load mailboxes
    try {
      const result = await invoke('list_mailboxes', { integration_id: iid });
      const data = result[iid];
      const folderSelect = document.getElementById('emailFolderSelect');
      if (data && data.ok) {
        const mailboxes = data.result.mailboxes || [];
        folderSelect.innerHTML = '';
        for (const mb of mailboxes) {
          folderSelect.innerHTML += `<option value="${escapeHtml(mb.name)}">${escapeHtml(mb.name)}</option>`;
        }
        // Load messages from first mailbox
        if (mailboxes.length > 0) {
          state.selectedEmailFolder = mailboxes[0].name;
          loadEmailList();
        }
      }
    } catch (err) {
      showError('Failed to load mailboxes: ' + err.message);
    }
  });

  document.getElementById('emailFolderSelect').addEventListener('change', (e) => {
    state.selectedEmailFolder = e.target.value;
    loadEmailList();
  });

  async function loadEmailList() {
    if (!state.selectedEmailIntegration || !state.selectedEmailFolder) return;

    showLoading('Loading messages…');
    try {
      const result = await invoke('list_messages', {
        integration_id: state.selectedEmailIntegration,
        folder: state.selectedEmailFolder,
        limit: 30,
      });

      const container = document.getElementById('emailList');
      if (result.ok && result.result && result.result.headers) {
        state.currentEmailList = result.result.headers;
        if (state.currentEmailList.length === 0) {
          container.innerHTML = '<div class="empty-state">No messages</div>';
          return;
        }
        container.innerHTML = state.currentEmailList.map(msg => `
          <div class="email-list-item" data-uid="${msg.uid}" data-folder="${msg.folder || state.selectedEmailFolder}">
            <div class="eli-subject">${escapeHtml(truncate(msg.subject || '(No subject)', 40))}</div>
            <div class="eli-from">${escapeHtml(truncate(msg.from_ || '', 30))}</div>
            <div class="eli-date">${formatDateShort(msg.date)}</div>
          </div>
        `).join('');

        container.querySelectorAll('.email-list-item').forEach(item => {
          item.addEventListener('click', () => {
            container.querySelectorAll('.email-list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            openMessage(state.selectedEmailIntegration, item.dataset.folder, item.dataset.uid);
          });
        });
      } else {
        container.innerHTML = `<div class="error-state">${escapeHtml(result.error || 'Failed to load messages')}</div>`;
      }
    } catch (err) {
      showError('Failed to load messages: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  async function openMessage(iid, folder, uid) {
    showLoading('Opening message…');
    try {
      const result = await invoke('fetch_message', {
        integration_id: iid,
        folder: folder,
        uid: uid,
      });

      const container = document.getElementById('emailDetail');
      if (result.ok && result.result && result.result.message) {
        const msg = result.result.message;
        const header = msg.header || {};
        state.selectedMessage = msg;

        container.innerHTML = `
          <div class="ed-subject">${escapeHtml(header.subject || '(No subject)')}</div>
          <div class="ed-meta">
            <div><strong>From:</strong> ${escapeHtml(header.from_ || '')}</div>
            <div><strong>To:</strong> ${escapeHtml(header.to || '')}</div>
            <div><strong>Date:</strong> ${escapeHtml(header.date || '')}</div>
            <div>${integrationBadge(iid)}</div>
          </div>
          <div class="ed-body">${escapeHtml(msg.body_text || '(No body content)')}</div>
        `;
      } else {
        container.innerHTML = `<div class="error-state">${escapeHtml(result.error || 'Failed to load message')}</div>`;
      }
    } catch (err) {
      showError('Failed to open message: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  document.getElementById('emailSearchBtn').addEventListener('click', async () => {
    const query = document.getElementById('emailSearchInput').value.trim();
    if (!query || !state.selectedEmailIntegration) {
      showError('Select an integration and enter a search query');
      return;
    }

    showLoading('Searching…');
    try {
      const result = await invoke('search_messages', {
        integration_id: state.selectedEmailIntegration,
        query: query,
        folder: state.selectedEmailFolder,
        limit: 30,
      });

      const container = document.getElementById('emailList');
      if (result.ok && result.result && result.result.headers) {
        const messages = result.result.headers;
        if (messages.length === 0) {
          container.innerHTML = '<div class="empty-state">No matches found</div>';
          return;
        }
        container.innerHTML = messages.map(msg => `
          <div class="email-list-item" data-uid="${msg.uid}" data-folder="${msg.folder || state.selectedEmailFolder}">
            <div class="eli-subject">${escapeHtml(truncate(msg.subject || '(No subject)', 40))}</div>
            <div class="eli-from">${escapeHtml(truncate(msg.from_ || '', 30))}</div>
            <div class="eli-date">${formatDateShort(msg.date)}</div>
          </div>
        `).join('');

        container.querySelectorAll('.email-list-item').forEach(item => {
          item.addEventListener('click', () => {
            container.querySelectorAll('.email-list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            openMessage(state.selectedEmailIntegration, item.dataset.folder, item.dataset.uid);
          });
        });
      } else {
        container.innerHTML = `<div class="error-state">${escapeHtml(result.error || 'Search failed')}</div>`;
      }
    } catch (err) {
      showError('Search failed: ' + err.message);
    } finally {
      hideLoading();
    }
  });

  document.getElementById('emailSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('emailSearchBtn').click();
  });

  // ─── Compose Email ───────────────────────────────────────────────

  document.getElementById('emailComposeBtn').addEventListener('click', () => {
    document.getElementById('composeModal').style.display = 'flex';
  });

  document.getElementById('composeSendBtn').addEventListener('click', async () => {
    const iid = document.getElementById('composeIntegration').value;
    const to = document.getElementById('composeTo').value;
    const subject = document.getElementById('composeSubject').value;
    const body = document.getElementById('composeBody').value;

    if (!iid || !to || !subject || !body) {
      showError('Please fill in all fields');
      return;
    }

    showLoading('Sending email…');
    try {
      const result = await invoke('send_message', {
        integration_id: iid,
        to: to,
        subject: subject,
        body: body,
      });

      if (result.ok) {
        document.getElementById('composeModal').style.display = 'none';
        document.getElementById('composeTo').value = '';
        document.getElementById('composeSubject').value = '';
        document.getElementById('composeBody').value = '';
        showError('Email sent successfully!');
      } else {
        showError('Failed to send: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      showError('Failed to send email: ' + err.message);
    } finally {
      hideLoading();
    }
  });

  // ─── Refresh Button ─────────────────────────────────────────────

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    if (activeTab === 'dashboard') {
      await loadDashboard();
    } else if (activeTab === 'email') {
      await loadEmailList();
    } else if (activeTab === 'calendar') {
      document.getElementById('calLoadBtn').click();
    }
    setTimeout(() => btn.classList.remove('spinning'), 600);
  });

  // ─── Init ───────────────────────────────────────────────────────

  async function init() {
    showLoading('Initializing…');
    try {
      // Load integrations first
      const result = await invoke('get_integrations');
      state.integrations = result;

      // Initialize all tabs
      await initCalendarTab();
      await initEmailTab();

      // Load dashboard
      await loadDashboard();
    } catch (err) {
      showError('Initialization failed: ' + err.message);
      console.error(err);
    } finally {
      hideLoading();
    }
  }

  init();
})();