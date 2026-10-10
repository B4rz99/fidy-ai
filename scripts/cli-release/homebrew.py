"""Print a Homebrew formula for the verified macOS ARM64 candidate; never publish it."""
import argparse
import hashlib
from pathlib import Path
import re
import stat
import struct
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('version', help='Explicit three-component CLI release version')
parser.add_argument('release_directory', type=Path, help='Final candidate archive and checksum directory')
args = parser.parse_args()

if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', args.version):
    parser.error('Invalid release version.')

archive = args.release_directory / 'fidy-darwin-arm64.zip'
try:
    manifest = archive.with_suffix('.zip.sha256').read_text()
    match = re.fullmatch(r'([a-f0-9]{64})  fidy-darwin-arm64\.zip\n?', manifest)
    if match is None:
        parser.error('Invalid checksum manifest.')
    with archive.open('rb') as candidate:
        digest = hashlib.file_digest(candidate, 'sha256').hexdigest()
    if digest != match[1]:
        parser.error('Checksum mismatch; no formula generated.')
    with zipfile.ZipFile(archive) as bundle:
        if bundle.namelist() != ['fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']:
            parser.error('Unexpected archive contents.')
        for entry in bundle.infolist():
            if not stat.S_ISREG(entry.external_attr >> 16) or entry.file_size == 0:
                parser.error('Invalid archive entry.')
        with bundle.open('fidy') as executable:
            magic, cpu, _, kind, count, command_bytes, _, _ = struct.unpack('<8I', executable.read(32))
            if magic != 0xfeedfacf or cpu != 0x0100000c or kind != 2:
                parser.error('Expected a macOS ARM64 executable.')
            if not 0 < count <= 256 or not 0 < command_bytes <= 65536:
                parser.error('Invalid Mach-O load commands.')
            commands = executable.read(command_bytes)
        offset = 0
        deployment_targets = []
        for _ in range(count):
            command, size = struct.unpack_from('<2I', commands, offset)
            if size < 8 or offset + size > len(commands):
                parser.error('Invalid Mach-O load command.')
            if command == 0x32:
                if size < 24:
                    parser.error('Invalid Mach-O build version.')
                deployment_targets.append(struct.unpack_from('<2I', commands, offset + 8))
            offset += size
        if offset != command_bytes or deployment_targets != [(1, 0x000d0000)]:
            parser.error('Unexpected macOS deployment target; review formula requirements.')
except (OSError, UnicodeError, zipfile.BadZipFile, struct.error) as error:
    parser.error(f'Cannot read candidate: {error}')

# Package license decisions and anonymous/native verification remain release gates, not generator claims.
print(f'''# Generated from verified candidate bytes; review release gates before publishing to a tap.
class Fidy < Formula
  desc "Personal finance from the terminal"
  homepage "https://app.fidyapp.com"
  version "{args.version}"
  url "https://github.com/B4rz99/fidy-ai/releases/download/cli-v{args.version}/fidy-darwin-arm64.zip"
  sha256 "{digest}"

  depends_on macos: :ventura
  depends_on arch: :arm64

  def install
    bin.install "fidy"
    pkgshare.install "BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"
  end

  test do
    assert_equal "fidy #{{version}}\\n", shell_output("#{{bin}}/fidy --version")
    assert_match "fidy login", shell_output("#{{bin}}/fidy --help")
    assert_predicate pkgshare/"BUN-LICENSE.txt", :file?
    assert_predicate pkgshare/"THIRD-PARTY-NOTICES.txt", :file?
  end
end''')
