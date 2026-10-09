# Installable Fidy CLI

This is the release-candidate installation contract. No public CLI release is implied by this
source change. The workflow builds candidates only; it has no release-write permission.

## End-user experience after publication

Download `install.sh` (macOS/Linux) or `install.ps1` (Windows) from the approved, versioned
`cli-v0.1.0` GitHub release in `B4rz99/fidy-ai`. Review the script, then run:

```sh
bash install.sh 0.1.0
# If the installer reports a missing PATH entry, add the printed directory to PATH.
fidy --version
fidy login
fidy commands
```

On Windows PowerShell:

```powershell
.\install.ps1 -Version 0.1.0
fidy --version
fidy login
```

Do not bypass PowerShell execution policy or OS security warnings. Signed/notarized distribution
must be arranged before a general public launch if required by the target environment.
The Windows installer adds `%LOCALAPPDATA%\Programs\Fidy` to this session and the user's PATH.
The POSIX installer uses `~/.local/bin` (override with `FIDY_INSTALL_DIR`) without editing shell files.
Neither installer needs administrator access or changes authentication/security settings.

The executable includes the reviewed Bun runtime: no Bun/Node installation, repository clone or
workspace dependency installation is required. Initial candidates support macOS Apple Silicon,
Windows x64 and glibc Linux x64. The retained x64 runtime requires AVX2. Other OS/CPU combinations fail explicitly rather than selecting
an untested binary. Linux needs a working Secret Service/GNOME Keyring/KWallet; macOS uses Keychain;
Windows uses the reviewed local credential persistence. There is no plaintext fallback.
`--help` and `--version` work without a login, network or credential store.

## Release preparation

1. Build on each native runner using `scripts/cli-release/build.sh`; no cross-target runtime fetch.
2. Require normal repository CI plus the `CLI release candidates` matrix to pass for the exact SHA.
3. Download all three candidate artifacts. Inspect packaged binary names, version output and
   checksum files. Exercise real login/status/logout on supported desktop targets before launch.
4. Obtain owner approval for publication and any signing/credential setup. Sign/notarize where
   appropriate, then regenerate checksums for the final archive bytes and retest installation.
5. Publish a versioned `cli-v0.1.0` release with the three `fidy-OS-ARCH.zip` files, their individual
   `.sha256` files and both installers. Never replace assets under an existing version tag.
6. Verify anonymous download access before advertising installation. If this repository is private,
   use an explicitly approved public distribution repository; these installers cannot read private
   release assets without credentials and deliberately do not request/store a GitHub token.
7. Only then replace source-checkout instructions in the public agent guide with the verified URL.

The SHA-256 checks reject corruption and unexpected archive contents before installation. They
are not a signature against a compromised GitHub release owner: the archive and digest share an
origin. Keep release permissions restricted and use signed distribution for stronger provenance.
Upgrades use an explicit version and verify before replacing the old executable. Removing the
binary does not revoke server grants or delete saved credentials; run `fidy logout` first and
revoke the grant in Fidy when appropriate. No automatic update background process is installed.

## Build and regression checks

```sh
bash scripts/install-bun.sh
bash scripts/install-workspace.sh
bash scripts/cli-release/build.sh
python3 scripts/cli-release/test-install.py
```

Standalone bundling follows [Bun's executable build documentation](https://bun.sh/docs/bundler/executables).
The pinned runtime guard remains active in the resulting executable. The workflow validates native
compilation/help/version on all three target OSes; existing repository native-store conformance
checks remain required. A passing build is not evidence that code signing or production pairing
has been completed.
