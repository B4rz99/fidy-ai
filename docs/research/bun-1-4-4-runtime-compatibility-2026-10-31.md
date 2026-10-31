# Bun 1.4.4 runtime compatibility

**Official Bun 1.4.4 is a source-supported replacement candidate for the jsdom startup failure,
while retaining explicit Windows local-only Secrets persistence. It is not yet a validated Fidy
runtime pin.** Its notice inventory has expanded, and the native-provider and full CI proofs must
run against the proposed exact revision before adoption. Do not weaken credential checks or add
a broad VM monkey patch to pass the DOM suite.

This research read repository contracts and official upstream source/release metadata only. It
made no application/toolchain edits, installed no runtime, ran no credential tests and contacted
no infrastructure provider. Root's separate local binary investigation is not evidence supplied
by this note.

## Exact identities and relevant fix

The official `bun-v1.4.4` tag resolves to
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`, published 22 October 2026. The current reviewed source is
`13a98b0dbd136bcc5c98a8adfb53c909aa3183cc` (`1.4.3-canary.1+13a98b0db`). The release explicitly fixes
`vm.createContext(vm.constants.DONT_CONTEXTIFY)` returning a wrapper instead of the context global,
which prevented Vitest/jsdom 30.1 startup, and prototype-chain name resolution used by jsdom 30
with `runScripts`. This is a concrete upstream fix relevant to the reported EventTarget brand
failure, not proof that all seven Fidy DOM workers now pass.
[Official release notes](https://bun.com/blog/bun-v1.4.4),
[tag ref](https://api.github.com/repos/oven-sh/bun/git/ref/tags/bun-v1.4.4),
[release metadata](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4).

## Windows credential behavior survives in source

Compared the old and new immutable source revisions directly:

| File                                  | Comparison and significance                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/jsc/bindings/JSSecrets.cpp`      | Byte-identical; SHA-256 `73aba350b0bcfbf93668feae754db1aca56b091173a3f7c31becf69c2b63ff48` at both revisions. Parser accepts explicit `local` and `enterprise`; its default remains Enterprise. The parsed enum reaches `Secrets::setPassword`.                                                                                                   |
| `src/jsc/JSSecrets.rs`                | Byte-identical; SHA-256 `ea498cee796b180d1aeb27ade983ebaf20ab0b7a7d067d225195701e69bbb691`.                                                                                                                                                                                                                                                       |
| `src/jsc/bindings/SecretsWindows.cpp` | Changed for `CString` → `UTF8CString` and associated pointer/span APIs. `Persist::Local` still maps to `CRED_PERSIST_LOCAL_MACHINE`; `Persist::Enterprise` still maps to `CRED_PERSIST_ENTERPRISE`; `cred.Persist = toCredPersist(persist)` precedes `CredWriteW`. Target naming, generic credential type and best-effort plaintext scrub remain. |
| `src/jsc/bindings/Secrets.h`          | String signature migration; retains Local/Enterprise enum and persistence argument.                                                                                                                                                                                                                                                               |
| Darwin/Linux Secrets backends         | Also have string API migrations. Their presence is reason to repeat native tests, not assume unchanged compiled behavior from the Windows mapping alone.                                                                                                                                                                                          |

Sources: old/new
[JS parser, old](https://github.com/oven-sh/bun/blob/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc/src/jsc/bindings/JSSecrets.cpp),
[JS parser, new](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/JSSecrets.cpp),
[Windows, old](https://github.com/oven-sh/bun/blob/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc/src/jsc/bindings/SecretsWindows.cpp),
[Windows, new](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/SecretsWindows.cpp),
[header](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/Secrets.h),
[Rust binding](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/JSSecrets.rs),
[Darwin](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/SecretsDarwin.cpp),
[Linux](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/SecretsLinux.cpp).

The Windows file hashes are old `22dc409bc52c999457c2b22642b1ac6de7a5fdabed688f6ccd6f0afb130d5a5c`
and new `851dfff813eee458a87cb9684e3f3cedd2ff4d95b9cfb8614fdac6b08031192b`.
This is source comparison, not a binary/source reproducibility attestation or native-provider proof.

Fidy must retain explicit `persist: "local"`: omitting it would retain upstream's Enterprise
default. Keep the fixed service, Redacted boundaries, metadata/bearer consistency checks, lock,
private paths and absence of plaintext/environment fallback. The current
[credential adapter](../../apps/cli/src/credential/runtime.ts) refuses other `Bun.revision` values
before native access. Adoption therefore requires deliberately updating that exact reviewed
revision, rather than disabling its guard. See the
[CLI architecture](../../apps/cli/ARCHITECTURE.md#credential-exception-and-local-persistence).

## Notice inventory must change

Current [BUN-NOTICES.md](../../scripts/cli-release/BUN-NOTICES.md) matches the old upstream
`LICENSE.md` after ignoring table alignment/separators and whitespace. New upstream adds **27 table
entries plus explanatory text**. They cover checker/parser origins and lint/format ports and
attribution, including MIT, Apache-2.0, BSD and ISC notices. Carry the complete new upstream notice
text rather than selectively omitting capabilities the CLI does not invoke. This observation is
an inventory check, not a legal conclusion about distribution obligations.
[Old inventory](https://github.com/oven-sh/bun/blob/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc/LICENSE.md),
[new inventory](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md).

Upstream `LICENSE.md` SHA-256 changes from
`b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a` to
`362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd`.
The JavaScriptCore/WebKit source pin also changes from
`5718a6ec579b98362ea7276a426deedcc6281ef5` to
`d6375c72affe0f70222cdcb45012b10f0bf3a9d5` in
[the old build dependency](https://github.com/oven-sh/bun/blob/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc/scripts/build/deps/webkit.ts)
and [new build dependency](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/scripts/build/deps/webkit.ts).
Keep runtime source/rebuild instructions and the accompanying application bundle in published
packages. [Notice generation](../../scripts/cli-release/notices.py) currently embeds the old exact
source URL and must move with the runtime and notice inventory.

## Archive identity and adoption gates

Official release metadata advertises these six matching platform assets and SHA-256 digests.
These are metadata observations; this researcher did not download or hash the archives.
[Official assets](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4).

| Archive                   | Advertised SHA-256                                                 |
| ------------------------- | ------------------------------------------------------------------ |
| `bun-darwin-aarch64.zip`  | `c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510` |
| `bun-darwin-x64.zip`      | `50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e` |
| `bun-linux-aarch64.zip`   | `baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e` |
| `bun-linux-x64.zip`       | `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c` |
| `bun-windows-aarch64.zip` | `2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09` |
| `bun-windows-x64.zip`     | `cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5` |

[Installer](../../scripts/install-bun.sh) currently verifies six retained canary archives and exact
revision. A deliberate stable upgrade must preserve fail-closed archive verification, supported
targets and executable/bunx handling; update exact source/revision, digests, installer/CI locations,
recovery text and package notices consistently. The reviewed architecture's interim requirement
to retain canary assets applies until verified stable local-only support; source support now
exists, while complete native/archive verification remains outstanding. Do not use moving
`latest`/`canary` bytes or claim a darwin binary proves the other targets.

Required evidence remains:

- Run the seven previously failing Vitest/jsdom workers and full CI on the selected exact runtime.
  Official fix wording alone cannot certify Fidy's EventTarget error resolved.
- Run the existing same-source cross-process native probe on Linux, macOS and Windows. Keep its
  separate deadline and fail-closed packaging/native jobs. Windows must still inspect the actual
  native entry's generic type and `Persist == 2`, never its bearer blob. The
  [probe](../../apps/cli/test/native-store.ts) and
  [Windows assertion](../../apps/cli/test/windows-persistence.ps1) already establish this seam.
- Re-run credential adapter failures/partial persistence, cleanup and packaged CLI verification
  under the exact revision, preserving occupied-slot refusal and no fallback. The current runtime
  guard intentionally rejects 1.4.4 until a reviewed adoption changes the pin.
- Independently hash selected archives; verify runtime revision on executable platforms, package
  same-run native artifacts and regenerate complete notices. Cross-platform source mapping and
  Windows runtime behavior cannot be inferred from this macOS research session.

The evidence supports trying the official stable fix without weakening credential policy. It
does not justify adopting it until these existing proofs pass.

## Local adoption verification

The installer now pins the official 1.4.4 release, full credential guard revision and all six advertised archive digests. The macOS arm64 archive was downloaded and its SHA-256 verified before extraction; its executable reports the expected full revision. Other platform digests remain metadata evidence until native CI installs them. The runtime notice inventory was refreshed from the pinned upstream LICENSE.md.

On the installed runtime, all 341 web unit tests, 98 CLI unit tests and the complete static verification passed. The old runtime failed jsdom worker startup before executing the focused test; 1.4.4 passes it. Native credential conformance and all required CI checks remain necessary before merge. No production performance gain is inferred from this tooling update.
