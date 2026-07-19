# Omnideck Projects Custom App

Omnideck Projects is a project-centric organizer for the conversations,
artifacts, files, and folders that accumulate while using Omnideck. Projects
are virtual collections, so the same item can belong to more than one project
without being copied or moved.

## What it does

- Creates named projects with descriptions, colors, and tags.
- Organizes conversations, indexed artifacts, files, and folders by reference.
- Provides an Inbox for unassigned conversations, artifacts, and recent files.
- Shows conversation metadata and disk usage without counting linked artifacts
  as conversation data.
- Expands conversations into per-file storage, linked artifact, and spawned-agent
  activity details without interpreting root-agent profile changes.
- Filters conversations by artifact presence or missing artifacts and sorts them
  by combined conversation-plus-artifact storage.
- Adds a conversation and all of its indexed artifacts to a project in one
  action.
- Identifies missing artifact files and artifacts whose source conversation no
  longer exists.
- Produces a cached, read-only storage report for large files, older files, and
  exact duplicates.
- Sends exact conversation, artifact, file, or folder resource context to
  Omnideck chat from each resource row.

The app deliberately has no delete, move, rename, archive, or cleanup actions
for source content. Deleting a project removes only the app's virtual
organization links.

## Persistent state

All state owned by this app is stored in `data/projects.sqlite3`, located
relative to `app.py`. This includes projects, tags, item relationships, notes,
small UI flags such as the first-run welcome state, and the most recent storage
report. The app does not write sidecar files into conversation, artifact, or
user-file directories.

The SQLite database uses Python's standard-library `sqlite3` module. No SQLite
server or additional container package is required.

## Install with your Omnideck agent

For now, ask an Omnideck agent to clone the
[`omnideck-custom-apps`](https://github.com/lefoulkrod/omnideck-custom-apps)
repository into persistent Omnideck storage and link or copy the
`omnideck-projects` subfolder into the configured Custom Apps directory. The
agent should not overwrite an existing app or its `data/` directory.

Custom Apps must be enabled under Settings → System → Experimental. Refresh or
reopen the app after frontend changes.

## Tests

```bash
npm install
npm test
uv run --with 'pytest>=8,<9' pytest
```

Backend tests use isolated temporary Omnideck state, user-file, and app-data
directories. Frontend tests use Vitest and jsdom.

## License

Copyright 2026 Larry Foulkrod. Licensed under the
[Apache License 2.0](LICENSE).

Bundled Bootstrap Icons are licensed under the MIT License. See
`THIRD_PARTY_LICENSES/BOOTSTRAP-ICONS-MIT.txt`.
