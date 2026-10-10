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
mkdir -p "$output/$target"
bun build apps/cli/src/main.ts --compile --minify --outfile "$output/$target/$executable"
"$output/$target/$executable" --version
"$output/$target/$executable" --help
cp scripts/cli-release/install.sh scripts/cli-release/install.ps1 "$output/"
python3 - "$output" "$target" "$executable" <<'PY'
from pathlib import Path
import hashlib,stat,sys,zipfile
root=Path(sys.argv[1]);target=sys.argv[2];name=sys.argv[3]
archive=root/f'fidy-{target}.zip'
entry=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0))
entry.create_system=3
entry.external_attr=(stat.S_IFREG | 0o755) << 16
entry.compress_type=zipfile.ZIP_STORED
# Stored bytes avoid host zlib versions and source mtimes changing the release digest.
with zipfile.ZipFile(archive,'w') as bundle:
    bundle.writestr(entry,(root/target/name).read_bytes())
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(root/f'fidy-{target}.zip.sha256').write_text(f'{digest}  {archive.name}\n')
PY
