# Unified Hub — Calendar & Email Integration App

## Overview
A custom Omnideck folder app that integrates with Larry's calendars and email
across both integrations (Google Workspace + iCloud). Calls the broker system
directly via UDS RPC protocol.

## Architecture

### Broker Communication
- Folder apps run in a subprocess with `-I` flag (isolated mode)
- `config` is importable; `integrations` is NOT
- Must implement RPC protocol directly: 4-byte BE length prefix + JSON body over UDS
- Two-hop: (1) resolve integration_id via supervisor app.sock, (2) call broker verb
- Supervisor socket: `/run/cvault/app.sock` (from `config.load_config()`)
- 8-second timeout per action — parallelize calls

### Integration IDs
- `google_workspace_lefoulkrod` — email(rw), calendar(rw), drive(rw), contacts(r)
- `icloud_larry_foulkrod` — email(rw), calendar(rw)

### Available Broker Verbs
**Email**: list_mailboxes, list_messages, search_messages, fetch_message, send_message, move_messages
**Calendar**: list_calendars, list_events, create_event, update_event, delete_event

## Backend Actions (app.py)
1. `get_dashboard()` — upcoming events + recent emails from all integrations (parallelized)
2. `list_calendars(integration_id)` — list calendars
3. `list_events(integration_id, calendar_url, days_forward, days_back, limit)` — list events
4. `create_event(integration_id, calendar_id, summary, start, end, description, location)` — create event
5. `list_mailboxes(integration_id)` — list mailboxes
6. `list_messages(integration_id, folder, limit)` — list messages
7. `search_messages(integration_id, query, folder, limit)` — search messages
8. `fetch_message(integration_id, folder, uid)` — fetch full message
9. `send_message(integration_id, to, subject, body)` — send email

## Frontend (web/)
- Tab navigation: Dashboard | Calendar | Email
- Dashboard: upcoming events cards + recent emails list
- Calendar: calendar selector, event list, create event form
- Email: mailbox selector, message list, message detail, search, compose
- Clean, responsive, Omnideck-consistent design

## File Structure
```
unified-hub/
  omnideck.json
  app.py
  data/
  web/
    index.html
    app.js
    app.css
```

## Testing
- Unit test the RPC helper functions
- Integration test by calling actions through the server
- Manual test via browser