#!/usr/bin/env bash
# Codex cloud setup for Fidy: Debian-based worker, no root required.
set -euo pipefail
project_root=${FIDY_PROJECT_DIR:-$(git rev-parse --show-toplevel)}
local_root=${FIDY_LOCAL_ROOT:-/workspace/.local}
for tool in apt-get apt-cache dpkg-deb dpkg-architecture dbus-run-session dbus-send openssl curl unzip; do
  command -v "$tool" >/dev/null || { printf 'Missing worker prerequisite: %s\n' "$tool" >&2; exit 1; }
done
mkdir -p "$local_root/bin" "$local_root/native-cli/apt/lists/partial" "$local_root/native-cli/apt/cache/archives/partial" "$local_root/native-cli/packages"
printf '%s\n' "$project_root" > "$local_root/native-cli/project-root"
cat > "$local_root/native-cli/apt.conf" <<APT
Dir::Etc::parts "-";
Dir::Etc::main "-";
Dir::Etc::sourcelist "-";
Dir::Etc::sourceparts "/etc/apt/sources.list.d";
Dir::State::lists "$local_root/native-cli/apt/lists";
Dir::Cache "$local_root/native-cli/apt/cache";
APT::Sandbox::User "$(id -un)";
APT
export APT_CONFIG="$local_root/native-cli/apt.conf"
apt-get -o Acquire::http::Proxy="${HTTP_PROXY:-}" -o Acquire::https::Proxy="${HTTPS_PROXY:-}" update
(
  cd "$local_root/native-cli/packages"
  apt-get -o Acquire::http::Proxy="${HTTP_PROXY:-}" -o Acquire::https::Proxy="${HTTPS_PROXY:-}" download gnome-keyring libgck-1-0 libgcr-base-3-1
)
for package in "$local_root"/native-cli/packages/*.deb; do
  dpkg-deb -x "$package" "$local_root/native-cli/root"
done
cd "$project_root"
# Replace the executable atomically so rerunning setup also works while Bun is running.
# The repository installer remains the sole authority for its revision and checksum.
runtime_directory=$(mktemp -d "$local_root/fidy-bun.XXXXXX")
trap 'rm -rf "$runtime_directory"' EXIT
bash scripts/install-bun.sh "$runtime_directory"
mkdir -p "$local_root/fidy-bun-pinned"
mv "$runtime_directory/bun" "$local_root/fidy-bun-pinned/bun"
ln -sf bun "$local_root/fidy-bun-pinned/bunx"
rm -rf "$runtime_directory"
trap - EXIT
export PATH="$local_root/fidy-bun-pinned:$PATH"
export BUN_INSTALL_CACHE_DIR="$local_root/../.cache/bun"
export PLAYWRIGHT_BROWSERS_PATH="$local_root/../.cache/ms-playwright"
bash scripts/install-workspace.sh
bun node_modules/playwright/cli.js install --only-shell chromium
cat > "$local_root/bin/fidy-native-tests" <<'LAUNCHER'
#!/usr/bin/env bash
# Run native CLI checks with an isolated, encrypted test keyring.
set -euo pipefail
if [[ "${FIDY_NATIVE_DBUS_SESSION:-}" != 1 ]]; then
  exec dbus-run-session -- env FIDY_NATIVE_DBUS_SESSION=1 "$0" "$@"
fi
local_root=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$local_root/fidy-bun-pinned:$local_root/native-cli/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$local_root/native-cli/root/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_CONFIG_HOME="$local_root/config"
export XDG_STATE_HOME="$local_root/state"
export ALCHEMY_HOME="$local_root/state/alchemy-auth"
export XDG_CACHE_HOME=$local_root/../.cache
export BUN_INSTALL_CACHE_DIR=$local_root/../.cache/bun
export PLAYWRIGHT_BROWSERS_PATH=$local_root/../.cache/ms-playwright
session_root=$(mktemp -d /tmp/fidy-native-keyring.XXXXXX)
export XDG_RUNTIME_DIR="$session_root/runtime"
export XDG_DATA_HOME="$session_root/data"
mkdir -m 700 "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$session_root/control"
daemon_pid=
cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$session_root"
}
trap cleanup EXIT
openssl rand -base64 32 | gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory="$session_root/control" > "$session_root/daemon.log" 2>&1 &
daemon_pid=$!
ready=false
for ((attempt=0; attempt<50; attempt++)); do
  if dbus-send --session --print-reply --reply-timeout=1000 --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  printf 'Native test keyring failed to start.\n' >&2
  exit 1
fi
project_root=${FIDY_PROJECT_DIR:-$(cat "$local_root/native-cli/project-root")}
cd "$project_root"
if [[ $# == 0 ]]; then
  bun run --cwd apps/cli test:native
  bun run --cwd apps/web test:browser:cli
else
  "$@"
fi
LAUNCHER
chmod +x "$local_root/bin/fidy-native-tests"
"$local_root/bin/fidy-native-tests" bun run --cwd apps/cli test:native
printf 'Setup complete. Native test launcher: %s/bin/fidy-native-tests\n' "$local_root"
