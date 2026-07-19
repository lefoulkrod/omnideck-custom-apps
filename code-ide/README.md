# Code IDE Custom App

A VS Code-inspired editor for Omnideck Custom Apps. It provides a recursive
Explorer, recoverable editor tabs, file/content search and replace, previews,
Git status/diffs, formatter commands, configurable editing, and terminal
sessions backed by `app.py` actions.

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
