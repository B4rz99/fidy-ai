# Install the Fidy CLI

On macOS Apple Silicon or glibc Linux x64 desktops:

```sh
curl -fsSL https://fidyapp.com/install.sh | bash
```

On Windows x64, PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://fidyapp.com/install.ps1).Content))
```

Open a new terminal if prompted, then run `fidy login`. Neither installer requires administrator
access, a repository clone, Bun or Node. The executable contains the pinned Bun runtime.
Bash, Zsh and Fish receive idempotent user PATH configuration; Windows updates the user's PATH.
The POSIX default is `~/.local/bin`; `FIDY_INSTALL_DIR` overrides it. Zsh respects `ZDOTDIR` and
Fish respects `XDG_CONFIG_HOME`. Windows uses `%LOCALAPPDATA%\Programs\Fidy`.

Rerun the same command to upgrade to the latest validated release. To choose a particular version:

```sh
curl -fsSL https://fidyapp.com/install.sh | bash -s -- 0.1.0
```

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://fidyapp.com/install.ps1).Content)) -Version 0.1.0
```

The latest version comes from `https://api.fidyapp.com/cli/latest.txt`. Installers check the numeric
version, archive SHA-256, single executable entry and executable version before replacing an
installation. A failed download or integrity check preserves the previous executable and PATH.
There is no background updater. Checksums share the archive's GitHub origin; they do not protect
against a compromised release publisher. The current binaries are unsigned; installers do not
bypass execution policy or OS security controls.

Linux requires AVX2 and a working Secret Service/GNOME Keyring/KWallet. macOS uses Keychain;
Windows uses the retained credential persistence. No plaintext fallback is added. `fidy --version`
and `fidy --help` require neither login nor a credential store. Removing the binary does not revoke
server grants or remove credentials; use `fidy logout` and revoke the grant in Fidy when appropriate.

## Automated releases

`Publish CLI` runs after `Checks` succeeds for a push to `trunk`. It checks the exact source SHA,
bundles the CLI to enumerate its resolved inputs and compares their fingerprint, including emitted
bundle bytes, with the current
published release. CLI code, consumed contracts, bundled dependency code/metadata/notices, the
runtime pin, installers, packaging and compiler configuration that changes the bundle trigger a
release. Unrelated changes allocate no version.
Versions start at `0.1.0` and advance the patch number automatically.

All three native runners build the assigned version, compare same-source repeat archives and run
installer checks. Only after these jobs succeed does the publication job obtain release-write
permission. It uploads all archives, checksums, installers, resolved dependency notices,
the application bundle for rebuilding with Bun, version manifest and source fingerprint to a draft.
GitHub release immutability must be enabled (configured for `B4rz99/fidy-ai`). Publishing freezes
the assets and tag. The workflow anonymously downloads and compares every asset before setting
that release as GitHub's latest. The API reads the latest release's version asset; upstream failure
returns 503 and never selects an unvalidated version.

A failure or superseded source revision preserves the prior default. Reserved version tags are
never reused. Rerunning **all jobs** replans from current releases and allocates a new version if a
failed attempt reserved the preceding one. No separate maintainer publication approval is required.
The pull-request `CLI release candidates` workflow validates candidates without publishing.

## Build and focused regression checks

```sh
bash scripts/install-bun.sh
# Put the directory reported by this contributor-only setup on PATH.
bash scripts/install-workspace.sh
FIDY_CLI_VERSION=0.1.0 bash scripts/cli-release/build.sh
python3 scripts/cli-release/test-install.py
python3 scripts/cli-release/test-release.py
```

Standalone bundling follows [Bun's executable documentation](https://bun.sh/docs/bundler/executables).
Archive timestamps, executable mode and ZIP metadata are fixed; stored entries avoid host zlib
variation. Repeat builds prove identity in that native runner, not cross-toolchain identity or
reproducible signatures. Runtime guards and existing native credential-store checks remain active.
The runtime notice inventory is pinned alongside `scripts/install-bun.sh`; update both when changing
Bun. [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
allow changing the latest marker while preserving published assets and tags.
