# Installable Fidy CLI

This is the native installation and publication contract. No public CLI release is implied by
this source change. Public packaging requires the reviewed, source-bound redistribution evidence and
successful same-source release checks. Only the dedicated final publication job has release-write permission.

## End-user experience after publication

After the approved `cli-v0.1.0` release is published and verified anonymously, the primary
installation path uses its versioned native installer. No Homebrew, Node, npm, source checkout
or separate Bun installation is needed.

On macOS/Linux:

```sh
curl -fsSL https://github.com/B4rz99/fidy-ai/releases/download/cli-v0.1.0/install.sh | bash
```

On Windows PowerShell:

```powershell
irm https://github.com/B4rz99/fidy-ai/releases/download/cli-v0.1.0/install.ps1 | iex
```

These commands are publication instructions, not a claim that the assets already exist.
Both scripts default to the explicit reviewed version `0.1.0`; neither looks up `latest`.
They download the matching platform archive, verify its checksum and fixed contents,
check the binary version, and install its notices automatically without an acceptance prompt.
Alternatively, download and review the script before running it, with an optional version override:

```sh
bash install.sh 0.1.0
# If PATH is missing, use the full login command printed by the installer immediately,
# or add the printed directory to PATH before using fidy by name.
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
It needs Bash, curl, unzip, and either sha256sum or shasum. Windows uses native PowerShell
and .NET archive/checksum support. If an OS policy or warning blocks installation, stop and
resolve the supported signed-distribution path; do not disable the protection.
Neither installer needs administrator access or changes authentication/security settings.

The executable includes the reviewed Bun runtime: no Bun/Node installation, repository clone or
workspace dependency installation is required. Initial candidates support macOS 13+ Apple Silicon,
Windows x64 and glibc Linux x64. The retained x64 runtime requires AVX2. Other OS/CPU combinations fail explicitly rather than selecting
an untested binary. Linux needs a working Secret Service/GNOME Keyring/KWallet; macOS uses Keychain;
Windows uses the reviewed local credential persistence. There is no plaintext fallback.
`--help`, `--version` and `--license` work without a login, network or credential store.
`--license` identifies the Apple Public Source License component and the versioned
source/recipe asset; it never opens a browser or downloads anything. The source asset
contains the selected runtime/application source, full notices, the approved narrow CLI
modification grant, and recipient rebuild instructions. It accompanies the binary release
and is checked against the same reviewed source specification before publication.

## Release preparation

1. Complete and review the actual bundled-component inventory, full notices and corresponding
   source/relink evidence. Follow the [source-bound evidence contract](../../scripts/cli-release/publish-readiness.md).
   The checked-in manifest binds the reviewed materials; affirmative flags alone cannot approve a release.
   Any signing/notarization or additional source-asset requirements need their own reviewed
   implementation before approval. Do not choose a new first-party license implicitly.
2. Review and merge the preparation, then dispatch `Publish reviewed CLI release` on `trunk`
   with its exact 40-character commit SHA and version `0.1.0`. This is a fresh run, never a rerun.
   Preflight checks the reviewed source/material, repository visibility, current trunk and absence
   of the version tag/release before expensive work starts.
3. The read-only jobs reuse every ordinary repository check for that exact source, including
   security and native credential-store conformance, and build on all three native runners.
   `build.sh` validates material before compilation, checks binary version/help and creates
   deterministic archives. Every target must pass a same-source repeat-build ZIP comparison and
   actual executable installer tests. No cross-target runtime is downloaded.
4. The final write-scoped job accepts only the same run's three candidate artifacts and separate
   source artifact. It rechecks their exact layout, digests, reviewed notices, source installer bytes
   and every source archive member. The generated source manifest must first match the reviewed
   SHA-256 commitment in the compact checked-in recipe. It never executes downloaded files. It creates one draft,
   uploads ten assets once (three ZIP/checksum pairs, two installers, source archive/checksum), verifies them, then
   publishes `cli-v0.1.0`. Existing tags/releases are refused; assets are never replaced.
5. The job verifies all ten public downloads anonymously against the exact validated bytes.
   A failed or interrupted write may leave a draft, tag, assets or public release. Inspect GitHub
   before any further action; do not retry or overwrite blindly. A failure after publication is
   not a rollback. See the evidence contract for the recovery boundary.
6. Separately exercise actual anonymous installation and login/status/logout on supported desktop
   targets before launch. An offline installer test does not prove production pairing or native
   credential persistence. These installers cannot read private release assets and never request
   a GitHub token. An approved public distribution destination is required.
7. Only after those checks replace source-checkout instructions in the public agent guide with the verified URL.
   First-party `/install.sh` and `/install.ps1` aliases are a separate reviewed web-artifact change
   after the release works; do not publish aliases or advertise unavailable routes in advance.

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
# Non-distributable PR smoke: real binary, synthetic notices,
# private temporary fixtures only, no upload or release artifacts.
python3 scripts/cli-release/test-native.py
python3 scripts/cli-release/publish-test.py
# Requires complete, reviewed, source-bound distribution evidence:
bash scripts/cli-release/build.sh
python3 scripts/cli-release/test-install.py dist/cli-release
```

Standalone bundling follows [Bun's executable build documentation](https://bun.sh/docs/bundler/executables).
Archive timestamps, executable mode and ZIP metadata are fixed; stored entries avoid host zlib
variation. Each native CI job rebuilds into a second output directory and compares the complete ZIP
bytes. This proves repeatability in that runner, not cross-toolchain identity or reproducible signatures.
The pinned runtime guard remains active in the resulting executable. The workflow validates native
compilation/help/version on all three target OSes; existing repository native-store conformance
checks remain required. A passing build is not evidence that code signing or production pairing
has been completed.

Ordinary PR and standalone candidate-workflow dispatches retain native executable/installer
smoke tests using explicitly synthetic notice files in private temporary directories. Those
fixtures are deleted after testing and are never uploaded. This intentionally replaces the old
downloadable binary-only PR artifacts. Only a source-verified reusable publication invocation
can produce and upload distributable candidates, after the materials gate succeeds. The
separate native credential-store conformance jobs in ordinary repository CI are unchanged.

The reviewed bounded inventory covers 223 components. Application bundling identified Effect,
`@effect/platform-bun` and `@effect/platform-node-shared` 4.0.0, plus surviving Node/Joyent
Path adaptation. The runtime inventory is based on Bun commit
[`13a98b0dbd136bcc5c98a8adfb53c909aa3183cc`](https://github.com/oven-sh/bun/tree/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc),
including its pinned WebKit/JavaScriptCore and patched TinyCC sources. Full notices, the selected
corresponding source, recipient recipe and scoped CLI permission have completed independent
material review and are bound by the readiness manifest. Workspace/test dependencies are not
presumed shipped, and this review is not a legal-compliance guarantee.

Remaining launch checks are fresh exact-source CI and native credential conformance, same-run
source acquisition and publication, anonymous exact-byte downloads and native installation,
real pairing/status/logout and credential persistence, and applicable signing/OS-policy checks.
Landing and public agent-guide install claims follow those verified public results.
