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

This is the recommended installation method for CLI deployments, which keep
the virtual computer's home directory in a named volume. Ask your agent:

> Clone https://github.com/lefoulkrod/omnideck-custom-apps into the persistent
> Omnideck home directory. Install `code-ide` by linking or copying that
> subfolder into the Custom Apps directory. Do not overwrite an existing app
> or its `data/` directory.

The agent can discover the configured Custom Apps directory and perform the
installation from inside the virtual computer.

## Install from a shell

In the standard virtual computer, the persistent home is `/home/omnideck` and
Custom Apps are stored in `/home/omnideck/apps`.

Clone once and link the app so future `git pull` updates are immediately used:

```bash
cd /home/omnideck
git clone https://github.com/lefoulkrod/omnideck-custom-apps.git
ln -s ../omnideck-custom-apps/code-ide apps/code-ide
```

Alternatively, copy only the app you want into the Custom Apps directory:

```bash
cd /home/omnideck
git clone https://github.com/lefoulkrod/omnideck-custom-apps.git
cp -a omnideck-custom-apps/code-ide /home/omnideck/apps/
```

Restart or refresh Omnideck if the newly installed app does not appear
immediately. Runtime state belongs in each app's ignored `data/` directory.
