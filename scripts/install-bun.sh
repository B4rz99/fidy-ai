#!/usr/bin/env bash
# Exact asset identities and archive digests pin the approved experimental Secrets runtime.
set -euo pipefail
platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64) asset=610083042; archive=bun-darwin-aarch64; digest=e148ba743787aba0afae1a6685bbb649da886d526bdd838905dd15689dbae2ee ;;
  Darwin/x86_64) asset=610083046; archive=bun-darwin-x64; digest=5d05948f69151937798518dcebf856f2b0b77f6f2b51fcb3245c773203d7c3d5 ;;
  Linux/aarch64) asset=610083051; archive=bun-linux-aarch64; digest=21af51b3b6f7eb2877008e3b591bc46695f7b6df4a5a4e5a0af2dd556a864118 ;;
  Linux/x86_64) asset=610083118; archive=bun-linux-x64; digest=9eabb84e884fbd663d8c6f1afb10e0c8635472d95aa9abfc471eed84c3f292ab ;;
  MINGW*/aarch64|MSYS*/aarch64) asset=610083572; archive=bun-windows-aarch64; digest=56dc03b6beb0eb93776b8a0bfbccb680bc79e037eef58832b061c03c7448148f ;;
  MINGW*/x86_64|MSYS*/x86_64) asset=610083534; archive=bun-windows-x64; digest=f71491f083b481ea5ba5440042db64a3f65e77ccb58db979d9c228828dfff35b ;;
  *) printf 'Unsupported Bun installation platform. See apps/cli/ARCHITECTURE.md.\n' >&2; exit 1 ;;
esac
install_directory="${1:-$HOME/.fidy/bun-b73ae471a}"
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
if [[ "$("$install_directory/$executable" --revision)" != '1.4.3-canary.1+b73ae471a' ]]; then
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
