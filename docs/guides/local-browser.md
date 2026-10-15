# Local browser testing on macOS

Run the real API/Core/D1 browser fixture with Vite hot reload through one persistent local service.
Install repository dependencies first. This uses synthetic test identities and disposable financial
records; restarting resets the fixture database and requires a fresh browser login. No live provider
account or WhatsApp message is needed.

Once per worktree:

```sh
brew install mkcert
bun run dev:browser setup
```

Setup creates a certificate for loopback hosts in ignored `.local/browser/` and verifies macOS TLS
trust. If necessary it asks macOS to trust mkcert's CA in your login keychain; approve that OS prompt.
The CA's private key stays in mkcert's own directory. No TLS verification is disabled. Setup can be
rerun to renew an expired certificate. Restart the browser if it cached an earlier certificate error.

For each testing session:

```sh
bun run dev:browser
```

Open <https://127.0.0.1:4173/auth/pair> and choose **Iniciar sesión en el navegador**. Approve the
shown public pairing code using the loopback test operator:

```sh
curl --fail --request POST 'http://127.0.0.1:4175/approve?code=ABCD-EFGH&recurring=true'
```

Replace the example with the displayed code. The ordinary browser verifier, approval, and Core
session redemption still run; the operator substitutes the external WhatsApp approval only.
After sign-in, open <https://127.0.0.1:4173/app/recurring>.

```sh
bun run dev:browser status
bun run dev:browser restart
bun run dev:browser stop
```

The service runs under your macOS GUI login through launchd, independently of the launching shell
or agent turn. Start is idempotent and waits for both trusted HTTPS endpoints. Stop waits for all
three listeners to close. A busy port fails explicitly without terminating an unrelated process.
Only one worktree can own ports 4173–4175 at a time. The service does not start automatically when
you log in. Logs are in `.local/browser/server.log`; stop before running Playwright on these ports.
This helper does not replace `bun run dev` for Alchemy infrastructure development or CI acceptance.

The opt-in native regression check exercises startup-parent exit, reuse, TLS, stop/restart, and
occupied-port refusal against launchd itself. It leaves the local service running:

```sh
FIDY_BROWSER_SMOKE=1 bun node_modules/vitest/vitest.mjs run --config scripts/vitest.config.ts scripts/dev-browser.test.ts
```
