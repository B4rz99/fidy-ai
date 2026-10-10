# Installable Fidy CLI

This is the native installation and publication contract. No public CLI release is implied by
this source change. Public packaging is blocked until reviewed redistribution evidence is
complete. Only the dedicated final publication job has release-write permission.

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
`--help` and `--version` work without a login, network or credential store.

## Release preparation

1. Complete and review the actual bundled-component inventory, full notices and corresponding
   source/relink evidence. Follow the [source-bound evidence contract](../../scripts/cli-release/publish-readiness.md).
   The checked-in manifest is blocked; setting affirmative flags alone cannot approve a release.
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
4. The final write-scoped job accepts only the same run's three candidate artifacts and rechecks
   their exact layout, digests, reviewed notices and source installer bytes. It never executes
   downloaded files. It creates one draft, uploads the eight assets once, verifies them, then
   publishes `cli-v0.1.0`. Existing tags/releases are refused; assets are never replaced.
5. The job verifies all eight public downloads anonymously against the exact validated bytes.
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
# Safe while redistribution evidence is incomplete: real binary, synthetic notices,
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

The bounded inventory remains incomplete. Application bundling identified Effect,
`@effect/platform-bun` and `@effect/platform-node-shared` 4.0.0, plus surviving Node/Joyent
Path adaptation. The runtime inventory is based on Bun commit
[`13a98b0dbd136bcc5c98a8adfb53c909aa3183cc`](https://github.com/oven-sh/bun/tree/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc),
including its pinned WebKit/JavaScriptCore and patched TinyCC sources. Bun's root license
inventory is not a complete notice bundle. Remaining review includes selected native and
embedded-JavaScript notices, compiler-runtime provenance, selected Rust notices and transitive
closure, and platform-specific source obligations. Workspace/test dependencies are not presumed
shipped. These material gaps block publication independently of passing application tests.

## Homebrew preparation (not published)

The intended Apple Silicon experience is one command, `brew install B4rz99/tap/fidy`,
once the owner approves and publishes a public `B4rz99/homebrew-tap` repository and a
verified CLI release. Neither the tap nor that install command is available merely
because this preparation exists. Do not advertise it on the landing page or in
`llms.txt` until anonymous installation has passed.

Prepare the formula only from the final macOS ARM64 archive and its matching checksum:

```sh
python3 scripts/cli-release/test-homebrew.py
python3 scripts/cli-release/homebrew.py 0.1.0 dist/cli-release > /tmp/fidy.rb
```

The generator checks the actual archive digest, exact three-file layout, nonempty
regular files, ARM64 Mach-O deployment header and numeric version syntax before printing a formula. It does not
download, execute or publish anything. Its URL is versioned; it never uses `latest`,
changes the reviewed Bun pin, or infers that an unpublished asset is available.
The release operator must independently verify the binary version, actual platform,
minimum supported macOS version, complete notices/source obligations, release
provenance and anonymous access. No first-party license is inferred or assigned.

After those gates, review the generated file for `Formula/fidy.rb` in the approved
tap and test installation, `brew test B4rz99/tap/fidy`, upgrade and uninstall on a
supported Mac. The formula's offline test covers version/help and installed notices,
not account authorization or Keychain persistence. Homebrew installs the binary into
its managed prefix and preserves notices silently in its package share directory;
there is no license acceptance prompt, extra runtime download or shell-profile edit.
An existing Homebrew installation supplies PATH management. Login remains the user's
explicit `fidy login` step after installation. Uninstall does not revoke grants or
clear credentials; log out first and revoke grants separately when appropriate.

The formula requires an Apple Silicon Mac running macOS 13 Ventura or newer, matching
the retained runtime's deployment header. A different binary deployment target fails
generation until its formula requirements are reviewed. Windows and Linux retain their
separate release paths. Do not bypass OS warnings or modify security policy to make
the package install. Homebrew packaging does not itself establish code signing or
notarization. See Homebrew's [formula cookbook](https://docs.brew.sh/Formula-Cookbook)
and [tap guide](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap).
