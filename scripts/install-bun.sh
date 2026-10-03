#!/usr/bin/env bash
# Exact asset identities and archive digests pin the approved experimental Secrets runtime.
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) asset=607370259; archive=bun-darwin-aarch64; digest=d1197c909aeafda36c03d982f0aeee84522a8284aa45d099fc2f8d43230ebe6a ;;
  Darwin/x86_64) asset=607370260; archive=bun-darwin-x64; digest=96a5b8f4f79e8f3014f8c31c0ed8cb82844a4b7d2973bc4316291ed02573049d ;;
  Linux/aarch64) asset=607370258; archive=bun-linux-aarch64; digest=c7eeed35f8bcfd1c405b75e6fa660b61663f16dca9535b8229c0f2a6b1520d5c ;;
  Linux/x86_64) asset=607370294; archive=bun-linux-x64; digest=ae8d1d2c08cc04e1c3e8b7ddf9e336a101e2aaa70e3f71d811cc5c55191e1ac3 ;;
  MINGW*/aarch64|MSYS*/aarch64) asset=607370560; archive=bun-windows-aarch64; digest=5734959de049206c678e7d2e9c71b2f23765579108c8adb47414aba07f5cf364 ;;
  MINGW*/x86_64|MSYS*/x86_64) asset=607370513; archive=bun-windows-x64; digest=0a6c8db2dde3d0a1e52adec39562d70410063b91ca653b1c890f58e5812666f3 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-bb35d1b81}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
authorization=()
if [[ -n "${GH_TOKEN:-}" ]]; then
  authorization=(-H "Authorization: Bearer $GH_TOKEN")
fi
curl --fail --silent --show-error --location --max-time 120 \
  "${authorization[@]}" \
  -H 'Accept: application/octet-stream' \
  "https://api.github.com/repos/oven-sh/bun/releases/assets/$asset" \
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
if [[ "$("$install_directory/$executable" --revision)" != '1.4.3-canary.1+bb35d1b81' ]]; then
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
