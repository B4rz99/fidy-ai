#!/usr/bin/env bash
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) archive=bun-darwin-aarch64; asset=766782467; digest=b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10 ;;
  Darwin/x86_64) archive=bun-darwin-x64; asset=766782470; digest=a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd ;;
  Linux/aarch64) archive=bun-linux-aarch64; asset=766782468; digest=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;;
  Linux/x86_64) archive=bun-linux-x64; asset=766782581; digest=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb ;;
  MINGW*/aarch64|MSYS*/aarch64) archive=bun-windows-aarch64; asset=766783310; digest=41f57d49c3c6811888d9633c569e40b4eb1f7e92b5e5336e3abd3af03187d77a ;;
  MINGW*/x86_64|MSYS*/x86_64) archive=bun-windows-x64; asset=766783153; digest=815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-a7733435c}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
download_archive() {
  curl --fail --silent --show-error --location --retry 2 --retry-all-errors --retry-max-time 120 \
    --connect-timeout 15 --max-time 600 "$@" -o "$temporary_directory/bun.zip"
}
if ! download_archive "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/$archive.zip"; then
  printf 'Bun release download unavailable; using the official release asset API.\n' >&2
  download_archive --header 'Accept: application/octet-stream' \
    "https://api.github.com/repos/oven-sh/bun/releases/assets/$asset"
fi
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$temporary_directory/bun.zip" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$temporary_directory/bun.zip" | cut -d ' ' -f 1)"
fi
if [[ "$actual" != "$digest" ]]; then
  printf 'Pinned Bun archive checksum mismatch; refusing installation.\n' >&2
  exit 1
fi
unzip -q "$temporary_directory/bun.zip" -d "$temporary_directory"
mkdir -p "$install_directory"
if [[ "$platform" == MINGW* || "$platform" == MSYS* ]]; then
  executable=bun.exe
else
  executable=bun
fi
cp "$temporary_directory/$archive/$executable" "$install_directory/$executable"
chmod +x "$install_directory/$executable"
if [[ "$executable" == bun.exe ]]; then
  cp "$install_directory/$executable" "$install_directory/bunx.exe"
else
  ln -sf bun "$install_directory/bunx"
fi
if [[ "$("$install_directory/$executable" --revision)" != '1.4.5+a7733435c' ]]; then
  printf 'Pinned Bun revision mismatch; refusing installation.\n' >&2
  exit 1
fi
printf 'Installed pinned Bun in %s\n' "$install_directory"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  if command -v cygpath >/dev/null; then
    cygpath -w "$install_directory" >> "$GITHUB_PATH"
  else
    printf '%s\n' "$install_directory" >> "$GITHUB_PATH"
  fi
fi
