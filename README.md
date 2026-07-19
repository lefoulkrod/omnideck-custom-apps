# Omnideck Custom Apps

Custom Apps for [Omnideck](https://github.com/omnideck-dev/omnideck). Each
top-level directory is an independently installable app.

> [!WARNING]
> **Omnideck Custom Apps are an experimental feature.** A Custom App can include
> backend actions that read or modify files, run commands, and access other data
> available to the Omnideck runtime. Treat every app—including the apps in this
> repository—as untrusted until you have reviewed and understood its code.
>
> Review an app's `app.py`, frontend JavaScript, dependencies, and requested
> behavior before installing it. Review changes again before updating, keep
> backups of important data, and install only code you are comfortable allowing
> to run in your environment. Nothing in this repository should be treated as a
> security guarantee or a substitute for your own review.

## Install with your Omnideck agent

For now, Custom Apps must be installed by an Omnideck agent. In Omnideck, ask
your agent:

> Clone https://github.com/lefoulkrod/omnideck-custom-apps into the persistent
> Omnideck home directory. Install `code-ide` by linking or copying that
> subfolder into the Custom Apps directory. Do not overwrite an existing app
> or its `data/` directory.

The agent will discover the configured Custom Apps directory and perform the
installation in the correct persistent location.

Restart or refresh Omnideck if the newly installed app does not appear
immediately. Runtime state belongs in each app's ignored `data/` directory.

## License

Except where otherwise noted, original code in this repository is copyright
2026 Larry Foulkrod and licensed under the
[Apache License 2.0](LICENSE). Bundled third-party components remain under
their respective licenses; see [NOTICE](NOTICE) and
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

Each app directory also includes its own copy of these documents so the app
can be copied and distributed independently of this monorepo.
