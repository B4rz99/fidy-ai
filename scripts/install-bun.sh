#!/usr/bin/env bash
# Exact asset identities and archive digests pin the approved experimental Secrets runtime.
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) asset=610995354; archive=bun-darwin-aarch64; digest=66e08df554433266c0bdbe38ad8eec9eb0d57b2d71dd24559293269b52963ee7 ;;
  Darwin/x86_64) asset=610995358; archive=bun-darwin-x64; digest=4b1f81ac65fb043ec8518179f899a079372a1d8280ba9ec342a64d85a4989c80 ;;
  Linux/aarch64) asset=610995353; archive=bun-linux-aarch64; digest=125bddbcae7a04b6ec078e75b13a307c997908335342d90cd0c24202bd304dc6 ;;
  Linux/x86_64) asset=610995400; archive=bun-linux-x64; digest=b6d3d84e9fa690fd43a4d36b67b406d8fcff9f24d0aad62c115a2751b1fcf669 ;;
  MINGW*/aarch64|MSYS*/aarch64) asset=610995708; archive=bun-windows-aarch64; digest=5906a7546d9a958411d767a6a2e662c39d618e0ee9868672414752074a143a6e ;;
  MINGW*/x86_64|MSYS*/x86_64) asset=610995660; archive=bun-windows-x64; digest=208d1856f107d5b104a679d867f92857e4af381f29d211bd74ac3d621f74f0c6 ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-c7b06d94b}"
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
if [[ "$("$install_directory/$executable" --revision)" != '1.4.3-canary.1+c7b06d94b' ]]; then
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
