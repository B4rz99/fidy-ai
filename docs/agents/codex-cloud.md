# Codex cloud workers

Use this repository's setup script in the cloud environment configuration:

```bash
bash scripts/setup-codex-cloud.sh
```

Run it from the repository checkout. It targets the Debian-based managed worker, whose base image
already supplies D-Bus, OpenSSL, APT, Chromium system libraries, and the Debian archive keyring.
Setup needs network access to the configured Debian repositories, GitHub release downloads, npm,
SheetJS, and Playwright browser downloads. Preserve the worker's proxy and CA configuration.

Setup installs the repository-pinned Bun runtime, frozen workspace dependencies, Chromium headless
shell, and GNOME keyring packages under `/workspace`, without root. It validates native credential
storage across processes before completing. `FIDY_PROJECT_DIR` selects a checkout explicitly;
`FIDY_LOCAL_ROOT` overrides the default `/workspace/.local` installation directory.

Each test command needs its own live D-Bus and unlocked Secret Service session. A daemon started
only during setup does not supply that session to later agent commands. Use the installed launcher:

```bash
/workspace/.local/bin/fidy-native-tests
```

Without arguments, it runs native credential-store conformance and the native CLI browser journey.
For the complete repository gate:

```bash
/workspace/.local/bin/fidy-native-tests bun run verify
```

The launcher selects writable Alchemy, XDG, Bun, and Playwright directories. It creates an isolated
temporary encrypted test keyring, supplies its random password over standard input, and removes the
keyring after the command exits, including on command failure. It does not persist a real CLI login
between sessions. Live provider checks still require their configured credentials; this setup does
not enable them or waive repository verification failures.
