#!/usr/bin/env bash
# Installs only a versioned, checksum-verified Fidy release into the user's bin directory.
set -euo pipefail
[[ $# -le 1 ]] || { echo 'Usage: bash install.sh [VERSION]' >&2; exit 1; }
version="${1-0.1.0}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=linux-x64 ;;
  Darwin/arm64) target=darwin-arm64 ;;
  *) echo 'Supported: glibc Linux x64 or macOS arm64. Windows: use install.ps1.' >&2; exit 1 ;;
esac
for command in curl unzip; do command -v "$command" >/dev/null || { echo "Missing $command." >&2; exit 1; }; done
install_directory="${FIDY_INSTALL_DIR:-$HOME/.local/bin}"
temporary_directory="$(mktemp -d)"
staged_file=''
trap 'rm -rf "$temporary_directory"; [[ -z "$staged_file" ]] || rm -f "$staged_file"' EXIT
archive="fidy-$target.zip"
base="https://github.com/B4rz99/fidy-ai/releases/download/cli-v$version"
for file in "$archive" "$archive.sha256"; do
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 600 "$base/$file" -o "$temporary_directory/$file"
done
read -r expected filename < "$temporary_directory/$archive.sha256"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$filename" == "$archive" ]] || { echo 'Invalid checksum manifest.' >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$temporary_directory/$archive" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$temporary_directory/$archive" | cut -d ' ' -f 1)"
fi
[[ "$actual" == "$expected" ]] || { echo 'Checksum mismatch; nothing installed.' >&2; exit 1; }
[[ "$(unzip -Z1 "$temporary_directory/$archive")" == $'fidy\nBUN-LICENSE.txt\nTHIRD-PARTY-NOTICES.txt' ]] || { echo 'Unexpected archive contents.' >&2; exit 1; }
unzip -q "$temporary_directory/$archive" -d "$temporary_directory/extracted"
for file in fidy BUN-LICENSE.txt THIRD-PARTY-NOTICES.txt; do
  [[ -s "$temporary_directory/extracted/$file" && -f "$temporary_directory/extracted/$file" && ! -L "$temporary_directory/extracted/$file" ]] || { echo 'Invalid archive entry.' >&2; exit 1; }
done
chmod 755 "$temporary_directory/extracted/fidy"
[[ "$("$temporary_directory/extracted/fidy" --version)" == "fidy $version" ]] || { echo 'Release version mismatch.' >&2; exit 1; }
mkdir -p "$install_directory"
for file in fidy fidy-BUN-LICENSE.txt fidy-THIRD-PARTY-NOTICES.txt; do
  [[ ! -L "$install_directory/$file" && ! -d "$install_directory/$file" ]] || { echo 'Invalid installation destination.' >&2; exit 1; }
done
# Stage notices with private unique names; rename never follows an existing destination symlink.
for file in BUN-LICENSE.txt THIRD-PARTY-NOTICES.txt; do
  staged_file="$(mktemp "$install_directory/.fidy.XXXXXX")"
  cp "$temporary_directory/extracted/$file" "$staged_file"
  chmod 644 "$staged_file"
  mv -f "$staged_file" "$install_directory/fidy-$file"
  staged_file=''
done
staged_file="$(mktemp "$install_directory/.fidy.XXXXXX")"
cp "$temporary_directory/extracted/fidy" "$staged_file"
chmod 755 "$staged_file"
mv -f "$staged_file" "$install_directory/fidy"
staged_file=''
printf 'Installed Fidy %s in %s\n' "$version" "$install_directory"
case ":$PATH:" in
  *":$install_directory:"*) printf 'Run: fidy login\n' ;;
  *) printf 'Run now: %q login\nTo use fidy by name, add this directory to PATH:\n  export PATH=%q:"$PATH"\n' "$install_directory/fidy" "$install_directory" ;;
esac
