#!/usr/bin/env bash
# Exact asset identities and archive digests pin the approved experimental Secrets runtime.
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) asset=611743794; archive=bun-darwin-aarch64; digest=51c2eb666d3cd7426b420c4458b8c73962e9a922b193cac69a6193b31175d1fc ;;
  Darwin/x86_64) asset=611743787; archive=bun-darwin-x64; digest=a5d29b6e161c56fd2688e7b96609de1d727e23482da1223b85d76b3c545d7117 ;;
  Linux/aarch64) asset=611743793; archive=bun-linux-aarch64; digest=34279f19534bd65d58fed6f29e517192a6adcebde5650c1e9b7bb06931fe0e6c ;;
  Linux/x86_64) asset=611743861; archive=bun-linux-x64; digest=c65fc3d77e31a57b99e15b5f67100c482a24ec6ecdf7de28908a20cbf01d871a ;;
  MINGW*/aarch64|MSYS*/aarch64) asset=611744403; archive=bun-windows-aarch64; digest=9024bf9d20b51df0fa47cfbaa8e71ef8c7b6a74f4533e220568de18530581833 ;;
  MINGW*/x86_64|MSYS*/x86_64) asset=611744327; archive=bun-windows-x64; digest=667df1fe740db3324395117ae99b6541fa9d07b2527826d9b364d62cef0ad839 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-9bd19c98e}"
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
if [[ "$("$install_directory/$executable" --revision)" != '1.4.3-canary.1+9bd19c98e' ]]; then
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
