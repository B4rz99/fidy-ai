#!/usr/bin/env bash
# Retained release archives and digests pin the approved experimental Secrets runtime.
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) archive=bun-darwin-aarch64; digest=a51c03e0abe19b706f310f33feed5724a9b32b5c2279cf41751910307a60d792 ;;
  Darwin/x86_64) archive=bun-darwin-x64; digest=55c0d5851d9297e64329e798065f8fa19da8a86dc2ca37f9f539bfa2ef33f4be ;;
  Linux/aarch64) archive=bun-linux-aarch64; digest=d82163414c1a1d0918bb5804f86c1843b7050b763ca11fda212b5a9965cc1c33 ;;
  Linux/x86_64) archive=bun-linux-x64; digest=dd32f30cc152ca915ccf9adfee7313b1d578ee9c407d235f64dc9d1be1087951 ;;
  MINGW*/aarch64|MSYS*/aarch64) archive=bun-windows-aarch64; digest=0852178fc218b1c3276857b0d7a1020a4fccfe2297a12a69ef990deb9eac589d ;;
  MINGW*/x86_64|MSYS*/x86_64) archive=bun-windows-x64; digest=dd81403369b1435ae419e3d16137ec136614c882212e54961a47a2eb39f5b3e7 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-13a98b0db}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
curl --fail --silent --show-error --location --max-time 120 \
  "https://github.com/B4rz99/fidy-ai/releases/download/runtime-bun-13a98b0db/$archive.zip" \
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
if [[ "$("$install_directory/$executable" --revision)" != '1.4.3-canary.1+13a98b0db' ]]; then
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
