#!/usr/bin/env bash
# Stage the canonical installer bytes into the assets-only web artifact.
set -euo pipefail
source_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${1:?Output directory required}"
cp "$source_directory/install.sh" "$source_directory/install.ps1" "$1/"
cat >> "$1/_headers" <<'HEADERS'

/install.sh
  Content-Type: text/plain; charset=utf-8

/install.ps1
  Content-Type: text/plain; charset=utf-8
HEADERS
