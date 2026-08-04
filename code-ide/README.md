# Code IDE Custom App

A VS Code-inspired editor for Omnideck Custom Apps. It provides a recursive
Explorer, workspace folder picker, recoverable editor tabs, file/content search
and replace, previews, Git status with side-by-side editor diffs, formatter
commands, configurable editing, and terminal sessions backed by `app.py`
actions. New terminals start at the selected workspace root, while `cd` remains
local to the active terminal.

## Shortcuts

- `Ctrl+P` — Quick Open
- `Ctrl+Shift+P` — Command Palette
- `Ctrl+S` — Save
- `Ctrl+W` — Close active tab
- `Ctrl+B` — Toggle Explorer
- `Ctrl+\`` — Toggle terminal
- `Shift+Alt+F` — Format document
- `Ctrl+Shift+A` — Ask Omnideck about the selection or active file

## Tests

```bash
npm install
npm test
uv run --with 'pytest>=8,<9' pytest
```

The frontend suite uses Vitest with jsdom. The backend suite calls the Custom
App actions directly against isolated temporary home directories.

## Review

The Review view answers two questions about a changeset without making
you read the diff. Pick a base and a target, then run.

1. **Already in this project** — new code whose lines already exist in another
   file, and new function names that closely resemble an existing one. Tick
   "compare by meaning" to also catch a duplicate that was renamed, which needs
   a local embedding model (`pip install fastembed`, CPU only, no GPU).
2. **Tested** — for every new function, the names of the tests that call it.
   Test names read as sentences, so the list describes what is verified.
   Functions nothing reaches are listed separately, largest first.

Neither check is language specific. Duplicate detection compares normalized
text and works on any file. Test linkage relies on test-path conventions plus
the labelled-callback symbols in `symbols.py`, which cover both languages where
a test is a named function (Python, Go, Rust, Java) and languages where it is an
anonymous callback (JavaScript, TypeScript, Ruby, Go subtests). Any language it
cannot check for tests is named in the report rather than silently passing.

## Backend actions

Every browser-callable function in `app.py` is explicitly decorated with
`@custom_apps.action`; helper functions remain private to the Python process.
The app saves its recoverable UI state in `data/state.json`, the Custom Apps
persistent-data location. The frontend loads the SDK from
`/api/custom-apps/sdk.js`.

## Terminal runtime note

Omnideck runs every Python action in a fresh subprocess. Code IDE therefore
persists each terminal tab's working directory and history in the frontend,
while individual shell commands remain bounded action invocations rather than
one long-lived PTY process.

## License

Except where otherwise noted, original code in this app is copyright 2026
Larry Foulkrod and licensed under the [Apache License 2.0](LICENSE). Bundled
third-party components retain their respective licenses; see [NOTICE](NOTICE)
and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
