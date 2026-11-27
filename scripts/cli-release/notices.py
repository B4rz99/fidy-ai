"""Include notices for the resolved bundle and the pinned native runtime."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1])
inputs = json.loads((output / 'cli-inputs.json').read_text())['inputs']
packages = set()
for name in inputs:
    parts = Path(name).parts
    if parts[0] == 'node_modules':
        packages.add(Path(*parts[:3 if parts[1].startswith('@') else 2]))
sections = ['Fidy CLI third-party notices\n\nRuntime source and rebuild instructions:\n'
            'https://github.com/oven-sh/bun/tree/a7733435cf40429e3b35c36072769df2052b80f1\n'
            'The accompanying fidy.js contains the bundled application for use with a rebuilt runtime.\n',
            (root / 'scripts/cli-release/BUN-NOTICES.md').read_text()]
for package in sorted(packages):
    metadata = json.loads((root / package / 'package.json').read_text())
    licenses = sorted(path for path in (root / package).iterdir()
                      if path.is_file() and path.name.lower().startswith(('license', 'copying', 'notice')))
    if not licenses:
        raise ValueError(f'Missing bundled package notices: {package}')
    sections.append(f'{metadata["name"]} {metadata["version"]}\n' + '\n'.join(path.read_text() for path in licenses))
(output / 'THIRD-PARTY-NOTICES.txt').write_text('\n\n'.join(sections) + '\n')
