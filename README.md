# Omnideck Custom Apps

Personal Omnideck Custom Apps monorepo.

Each app lives in its own top-level directory and is linked into Omnideck's
`~/.omnideck/home/apps/` directory. For example, Code IDE is available at
`~/omnideck-custom-apps/code-ide` and linked as:

```text
~/.omnideck/home/apps/code-ide -> ../omnideck-custom-apps/code-ide
```

The relative link also resolves inside the Omnideck container, where the home
directory is mounted at `/home/omnideck`.
