#!/usr/bin/env bash
# Build natively with the retained runtime; never download a cross-compilation runtime.
set -euo pipefail
[[ "$(bun --revision)" == '1.4.3-canary.1+13a98b0db' ]] || { echo 'Use the reviewed Bun runtime.' >&2; exit 1; }
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=linux-x64; executable=fidy ;;
  Darwin/arm64) target=darwin-arm64; executable=fidy ;;
  MINGW*/x86_64|MSYS*/x86_64) target=windows-x64; executable=fidy.exe ;;
  *) echo 'This release supports Linux x64, macOS arm64 and Windows x64.' >&2; exit 1 ;;
esac
output="${1:-dist/cli-release}"
version_output="$(bun apps/cli/src/main.ts --version)"
version="${version_output#fidy }"
[[ "$version_output" == "fidy $version" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid CLI version output.' >&2; exit 1; }
[[ -z "${RELEASE_VERSION:-}" || "$RELEASE_VERSION" == "$version" ]] || { echo 'Requested release version differs from the CLI.' >&2; exit 1; }
# Incomplete redistribution evidence stops packaging; placeholder notices are never a release input.
python3 scripts/cli-release/publish.py materials --version "$version" --destination "$output/$target"
mkdir -p "$output/$target"
bun build apps/cli/src/main.ts --compile --minify --metafile="$output/$target/build-metafile.json" --outfile "$output/$target/$executable"
[[ "$("$output/$target/$executable" --version)" == "$version_output" ]] || { echo 'Compiled version differs from the CLI.' >&2; exit 1; }
printf '%s\n' "$version_output"
"$output/$target/$executable" --help
cp scripts/cli-release/install.sh scripts/cli-release/install.ps1 "$output/"
python3 - "$output" "$target" "$executable" <<'PY'
from pathlib import Path
import hashlib,stat,sys,zipfile
root=Path(sys.argv[1]);target=sys.argv[2];name=sys.argv[3]
archive=root/f'fidy-{target}.zip'
# Stored bytes avoid host zlib versions and source mtimes changing the release digest.
with zipfile.ZipFile(archive,'w') as bundle:
    for filename in (name,'BUN-LICENSE.txt','THIRD-PARTY-NOTICES.txt'):
        entry=zipfile.ZipInfo(filename,date_time=(1980,1,1,0,0,0))
        entry.create_system=3
        entry.external_attr=(stat.S_IFREG | (0o755 if filename == name else 0o644)) << 16
        entry.compress_type=zipfile.ZIP_STORED
        bundle.writestr(entry,(root/target/filename).read_bytes())
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(root/f'fidy-{target}.zip.sha256').write_bytes(f'{digest}  {archive.name}\n'.encode('ascii'))
PY
