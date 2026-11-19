# The runner pins one ephemeral loopback certificate in its own Chromium process.
set -eu
umask 077
export BROWSER_TLS_CERT="$RUNNER_TEMP/hosted-browser.pem" BROWSER_TLS_KEY="$RUNNER_TEMP/hosted-browser.key"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$BROWSER_TLS_KEY" -out "$BROWSER_TLS_CERT" -subj "/CN=localhost" 2>/dev/null
BROWSER_TLS_PIN="$(openssl x509 -in "$BROWSER_TLS_CERT" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)"
export BROWSER_TLS_PIN
