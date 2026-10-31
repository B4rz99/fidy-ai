#!/usr/bin/env bash
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) archive=bun-darwin-aarch64; digest=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
  Darwin/x86_64) archive=bun-darwin-x64; digest=50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e ;;
  Linux/aarch64) archive=bun-linux-aarch64; digest=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
  Linux/x86_64) archive=bun-linux-x64; digest=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
  MINGW*/aarch64|MSYS*/aarch64) archive=bun-windows-aarch64; digest=2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09 ;;
  MINGW*/x86_64|MSYS*/x86_64) archive=bun-windows-x64; digest=cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-38afee6c8}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 600 \
  "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/$archive.zip" \
  -o "$temporary_directory/bun.zip"
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
# Bun dispatches its package runner by executable name; publish it with the same pinned bytes.
if [[ "$executable" == bun.exe ]]; then
  cp "$install_directory/$executable" "$install_directory/bunx.exe"
else
  ln -sf bun "$install_directory/bunx"
fi
if [[ "$("$install_directory/$executable" --revision)" != '1.4.4+38afee6c8' ]]; then
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
