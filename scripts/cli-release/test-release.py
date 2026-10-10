"""Exercise release decisions and publication through their process boundary."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ['scripts/cli-release', 'apps/cli/src', 'bin']:
            (self.root / directory).mkdir(parents=True)
        for file in (ROOT / 'scripts/cli-release').iterdir():
            if file.is_file():
                shutil.copy(file, self.root / 'scripts/cli-release' / file.name)
        (self.root / 'scripts/install-bun.sh').write_text('pinned runtime')
        (self.root / 'apps/cli/package.json').write_text('{"type":"module"}')
        (self.root / 'apps/cli/src/main.ts').write_text('import { version } from "./contract"; console.log(version);')
        self.contract = self.root / 'apps/cli/src/contract.ts'
        self.contract.write_text('export const version = "contract-one";')
        self.state = self.root / 'state.json'
        self.state.write_text('[]')
        self.previous = self.root / 'previous.json'
        self.log = self.root / 'calls.jsonl'
        gh = self.root / 'bin/gh'
        gh.write_text('''#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
if args[0]=='api':
    if args[1].endswith('/releases'): print(json.dumps([json.load(open(os.environ['STATE']))]))
    elif args[1].endswith('/releases/latest'): print(json.dumps(json.load(open(os.environ['STATE']))[0]))
    elif '/releases/tags/' in args[1]: print('{"draft":false,"immutable":true}')
    elif args[1].endswith('/immutable-releases'): print('{"enabled":true}')
    elif '/git/ref/' in args[1]: print('{"object":{"sha":"' + 'a'*40 + '"}}')
elif args[:2]==['release','download']:
    shutil.copy(os.environ['PREVIOUS'],pathlib.Path(args[args.index('--dir')+1])/'cli-release.json')
elif args[:2]==['release','edit'] and '--latest=true' in args:
    pathlib.Path(os.environ['DEFAULT_FILE']).write_text(args[2])
''')
        gh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + os.pathsep + os.environ['PATH'],
                        STATE=str(self.state), PREVIOUS=str(self.previous), CALL_LOG=str(self.log),
                        GITHUB_REPOSITORY='B4rz99/fidy-ai', DEFAULT_FILE=str(self.root / 'default'))

    def plan(self):
        output = self.root / 'plan.json'
        result = subprocess.run(['python3', 'scripts/cli-release/release.py', 'plan', '--sha', 'a' * 40,
                                 '--output', str(output)], cwd=self.root, env=self.env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(output.read_text())

    def retain(self, plan):
        self.previous.write_text(json.dumps(plan))
        self.state.write_text(json.dumps([{'tag_name':'cli-v' + plan['version'], 'draft':False,
                                          'prerelease':False, 'immutable':True}]))

    def test_initial_release_gets_initial_version(self):
        plan = self.plan()
        self.assertTrue(plan['changed'])
        self.assertEqual(plan['version'], '0.1.0')

    def test_unrelated_changes_do_not_release(self):
        first = self.plan()
        self.retain(first)
        (self.root / 'unrelated-web.ts').write_text('changed web behavior')
        next_plan = self.plan()
        self.assertFalse(next_plan['changed'])
        self.assertEqual(next_plan['version'], '0.1.0')

    def test_consumed_contract_changes_increment_version(self):
        self.retain(self.plan())
        self.contract.write_text('export const version = "contract-two";')
        next_plan = self.plan()
        self.assertTrue(next_plan['changed'])
        self.assertEqual(next_plan['version'], '0.1.1')

    def test_consumed_dependency_metadata_changes_increment_version(self):
        package = self.root / 'node_modules/fixture-dependency'
        package.mkdir(parents=True)
        (package / 'package.json').write_text('{"name":"fixture-dependency","version":"1.0.0","main":"index.js"}')
        (package / 'index.js').write_text('export const dependency = "bundled";')
        (self.root / 'apps/cli/src/main.ts').write_text('import { dependency } from "fixture-dependency"; console.log(dependency);')
        self.retain(self.plan())
        (package / 'package.json').write_text('{"name":"fixture-dependency","version":"1.0.1","main":"index.js"}')
        self.assertTrue(self.plan()['changed'])

    def test_packaging_changes_increment_version(self):
        self.retain(self.plan())
        with (self.root / 'scripts/cli-release/install.sh').open('a') as script:
            script.write('\n# new packaging behavior\n')
        self.assertTrue(self.plan()['changed'])

    def test_consumed_compiler_configuration_changes_increment_version(self):
        configuration = self.root / 'tsconfig.base.json'
        configuration.write_text('{"compilerOptions":{"useDefineForClassFields":false}}')
        (self.root / 'apps/cli/tsconfig.json').write_text('{"extends":"../../tsconfig.base.json"}')
        (self.root / 'apps/cli/src/main.ts').write_text('class Example { value = 1; } console.log(new Example());')
        self.retain(self.plan())
        configuration.write_text('{"compilerOptions":{"useDefineForClassFields":true}}')
        next_plan = self.plan()
        self.assertTrue(next_plan['changed'])
        self.assertEqual(next_plan['version'], '0.1.1')

    def test_unconsumed_compiler_configuration_does_not_release(self):
        self.retain(self.plan())
        (self.root / 'apps/web').mkdir()
        (self.root / 'apps/web/tsconfig.json').write_text('{"compilerOptions":{"useDefineForClassFields":true}}')
        next_plan = self.plan()
        self.assertFalse(next_plan['changed'])
        self.assertEqual(next_plan['version'], '0.1.0')

    def publication(self, corrupt=False, missing=False, superseded=False):
        plan = self.plan()
        directory = self.root / 'assets'
        directory.mkdir()
        for target in ['darwin-arm64', 'linux-x64', 'windows-x64']:
            archive = directory / f'fidy-{target}.zip'
            archive.write_bytes(b'verified native candidate')
            (directory / (archive.name + '.sha256')).write_text(
                f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n')
        for name in ['install.sh', 'install.ps1']:
            shutil.copy(self.root / 'scripts/cli-release' / name, directory / name)
        (directory / 'THIRD-PARTY-NOTICES.txt').write_text('resolved package notices')
        (directory / 'fidy.js').write_text('application bundle')
        if missing:
            (directory / 'fidy-windows-x64.zip').unlink()
        if superseded:
            self.contract.write_text('export const version = \"superseded\";')
        downloader = self.root / 'bin/curl'
        downloader.write_text('''#!/usr/bin/env python3
import os,pathlib,shutil,sys
url=next(arg for arg in sys.argv if arg.startswith('https://'))
destination=sys.argv[sys.argv.index('-o')+1]
if os.environ.get('CORRUPT_DOWNLOAD')=='true': pathlib.Path(destination).write_bytes(b'corrupted')
else: shutil.copy(pathlib.Path(os.environ['FIXTURE_ASSETS'])/url.rsplit('/',1)[1],destination)
''')
        downloader.chmod(0o755)
        (self.root / 'default').write_text('previous-release')
        result = subprocess.run(['python3', 'scripts/cli-release/release.py', 'publish', '--plan',
                                 str(self.root / 'plan.json'), '--directory', str(directory)],
                                cwd=self.root, env=dict(self.env, FIXTURE_ASSETS=str(directory),
                                                       CORRUPT_DOWNLOAD=str(corrupt).lower()),
                                capture_output=True, text=True, timeout=30)
        return result, (self.root / 'default').read_text()

    def test_complete_verified_publication_advances_default(self):
        result, default = self.publication()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(default, 'cli-v0.1.0')

    def test_missing_platform_prevents_publication_and_preserves_default(self):
        result, default = self.publication(missing=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(default, 'previous-release')
        self.assertFalse(any(json.loads(line)[:2] == ['release', 'create'] for line in self.log.read_text().splitlines()))

    def test_changed_inputs_prevent_publication_and_preserve_default(self):
        result, default = self.publication(superseded=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(default, 'previous-release')
        self.assertFalse(any(json.loads(line)[:2] == ['release', 'create'] for line in self.log.read_text().splitlines()))

    def test_anonymous_verification_failure_preserves_default(self):
        result, default = self.publication(corrupt=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(default, 'previous-release')


if __name__ == '__main__':
    unittest.main()
