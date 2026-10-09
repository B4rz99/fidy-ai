#!/usr/bin/env bash
# Installs only a versioned, checksum-verified Fidy release into the user's bin directory.
set -euo pipefail
version="${1:?Usage: bash install.sh VERSION (for example 0.1.0)}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=linux-x64 ;;
  Darwin/arm64) target=darwin-arm64 ;;
  *) echo 'Supported: glibc Linux x64 or macOS arm64. Windows: use install.ps1.' >&2; exit 1 ;;
esac
for command in curl unzip; do command -v "$command" >/dev/null || { echo "Missing $command." >&2; exit 1; }; done
install_directory="${FIDY_INSTALL_DIR:-$HOME/.local/bin}"
temporary_directory="$(mktemp -d)"
staged_executable=''
trap 'rm -rf "$temporary_directory"; [[ -z "$staged_executable" ]] || rm -f "$staged_executable"' EXIT
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
[[ "$(unzip -Z1 "$temporary_directory/$archive")" == 'fidy' ]] || { echo 'Unexpected archive contents.' >&2; exit 1; }
unzip -q "$temporary_directory/$archive" -d "$temporary_directory/extracted"
[[ -f "$temporary_directory/extracted/fidy" && ! -L "$temporary_directory/extracted/fidy" ]] || { echo 'Invalid executable entry.' >&2; exit 1; }
chmod 755 "$temporary_directory/extracted/fidy"
[[ "$("$temporary_directory/extracted/fidy" --version)" == "fidy $version" ]] || { echo 'Release version mismatch.' >&2; exit 1; }
mkdir -p "$install_directory"
staged_executable="$(mktemp "$install_directory/.fidy.XXXXXX")"
cp "$temporary_directory/extracted/fidy" "$staged_executable"
chmod 755 "$staged_executable"
mv -f "$staged_executable" "$install_directory/fidy"
staged_executable=''
printf 'Installed Fidy %s in %s\n' "$version" "$install_directory"
case ":$PATH:" in
  *":$install_directory:"*) printf 'Run: fidy login\n' ;;
  *) printf 'Add this directory to PATH, then run fidy login:\n  export PATH="%s:$PATH"\n' "$install_directory" ;;
esac
