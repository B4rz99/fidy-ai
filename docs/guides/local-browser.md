# Local browser testing on macOS and Linux

The persistent local service runs Vite with the native Ingress, Core and SQLite Durable Objects in workerd. Install the repository dependencies before starting. The loopback fixture registers one synthetic WhatsApp identity. Restarting creates fresh owner storage and requires a new browser login.

Once per worktree:

```sh
brew install mkcert                              # macOS
sudo apt-get install mkcert libnss3-tools curl lsof  # Debian/Ubuntu
bun run dev:browser setup
```

Setup creates a certificate for loopback hosts in ignored `.local/browser/` and verifies TLS trust.
On macOS it asks to trust mkcert's CA in your login keychain; approve that OS prompt. On Linux it runs
`mkcert -install`, which adds the CA to the system store (through `sudo`) and to the Chrome/Firefox NSS
database in `~/.pki/nssdb`; restart an already running browser afterwards.
The CA's private key stays in mkcert's own directory. No TLS verification is disabled. Setup can be
rerun to renew an expired certificate. Restart the browser if it cached an earlier certificate error.

For each testing session:

```sh
bun run dev:browser
```

Open <https://127.0.0.1:4173/login> and choose **WhatsApp**. Approve the shown public pairing code
using the loopback test operator:

```sh
curl --fail --request POST 'http://127.0.0.1:4175/approve?code=ABCD-EFGH&recurring=true'
```

Replace the example with the displayed code. The local operator submits a signed synthetic WhatsApp callback through Ingress. Directory verifies the association and Core redeems the browser verifier against its User.
After sign-in, open <https://127.0.0.1:4173/app/recurring>.

```sh
bun run dev:browser status
bun run dev:browser restart
bun run dev:browser stop
```

On macOS the service runs under your GUI login through launchd. On Linux it runs as a detached
process group recorded in `.local/browser/server.pgid`. Either way it outlives the launching shell
or agent turn. Start is idempotent and waits for both trusted HTTPS endpoints. Stop waits for all
three listeners to close. A busy port fails explicitly without terminating an unrelated process.
Only one worktree can own ports 4173–4175 at a time. The service does not start automatically when
you log in. Logs are in `.local/browser/server.log`; stop before running Playwright on these ports.
This helper does not replace `bun run dev` for Alchemy infrastructure development or CI acceptance.

The opt-in native regression check exercises startup-parent exit, reuse, TLS, stop/restart, and
occupied-port refusal against the platform's service manager. It leaves the local service running:

```sh
FIDY_BROWSER_SMOKE=1 bun node_modules/vitest/vitest.mjs run --config scripts/vitest.config.ts scripts/dev-browser.test.ts
```
