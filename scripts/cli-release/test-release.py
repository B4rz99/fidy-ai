"""Exercise release decisions and publication through their process boundary."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

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
        state = self.state
        self.failed_page = self.root / 'failed-page'
        failed_page = self.failed_page

        class ReleasesHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                page = int(parse_qs(urlsplit(self.path).query).get('page', ['1'])[0])
                if failed_page.exists() and page == int(failed_page.read_text()):
                    self.send_error(503)
                    return
                releases = json.loads(state.read_text())
                start = (page - 1) * 30
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                if start + 30 < len(releases):
                    self.send_header('Link', f'<http://127.0.0.1:{self.server.server_port}/releases?page={page + 1}>; rel="next"')
                self.end_headers()
                self.wfile.write(json.dumps(releases[start:start + 30]).encode())

            def log_message(self, *_args):
                pass

        server = HTTPServer(('127.0.0.1', 0), ReleasesHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.previous = self.root / 'previous.json'
        self.log = self.root / 'calls.jsonl'
        gh = self.root / 'bin/gh'
        gh.write_text('''#!/usr/bin/env python3
import json,os,pathlib,shutil,subprocess,sys
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
if args[0]=='api':
    if args[1].endswith('/releases'):
        args[1]=os.environ['RELEASES_URL']
        sys.exit(subprocess.run([os.environ['REAL_GH'],*args],env=dict(os.environ,GH_TOKEN='synthetic-local-test')).returncode)
    elif args[1].endswith('/releases/latest'): print(json.dumps(json.load(open(os.environ['STATE']))[0]))
    elif '/releases/tags/' in args[1]: print(json.dumps({'draft':False,'immutable':os.environ.get('IMMUTABLE_RELEASE')=='true'}))
    elif args[1].endswith('/immutable-releases'):
        print('HTTP 403: Resource not accessible by integration',file=sys.stderr)
        sys.exit(1)
    elif '/git/ref/' in args[1]: print('{"object":{"sha":"' + 'a'*40 + '"}}')
elif args[:2]==['release','download']:
    shutil.copy(os.environ['PREVIOUS'],pathlib.Path(args[args.index('--dir')+1])/'cli-release.json')
elif args[:2]==['release','edit'] and '--latest=true' in args:
    pathlib.Path(os.environ['DEFAULT_FILE']).write_text(args[2])
''')
        gh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + os.pathsep + os.environ['PATH'],
                        STATE=str(self.state), PREVIOUS=str(self.previous), CALL_LOG=str(self.log),
                        REAL_GH=shutil.which('gh'), RELEASES_URL=f'http://127.0.0.1:{server.server_port}/releases',
                        GITHUB_OUTPUT=str(self.root / 'outputs'),
                        GITHUB_REPOSITORY='B4rz99/fidy-ai', DEFAULT_FILE=str(self.root / 'default'))

    def run_plan(self):
        return subprocess.run(['python3', 'scripts/cli-release/release.py', 'plan', '--sha', 'a' * 40,
                               '--output', str(self.root / 'plan.json')], cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def plan(self):
        result = self.run_plan()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((self.root / 'plan.json').read_text())

    def retain(self, plan):
        self.previous.write_text(json.dumps(plan))
        self.state.write_text(json.dumps([{'tag_name':'cli-v' + plan['version'], 'draft':False,
                                          'prerelease':False, 'immutable':True}]))

    def test_native_command_ownership_policy(self):
        result = subprocess.run(['python3', 'scripts/cli-release/test-command.py'],
                                cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_initial_release_gets_initial_version(self):
        plan = self.plan()
        self.assertTrue(plan['changed'])
        self.assertEqual(plan['version'], '0.1.0')

    def test_large_release_details_do_not_prevent_reserving_versions_from_later_pages(self):
        releases = [{'tag_name': 'runtime-bun-fixture', 'draft': False, 'prerelease': False,
                     'body': 'release notes' * 6000} for _ in range(30)]
        releases.extend([
            {'tag_name': 'cli-v0.8.3', 'draft': True, 'prerelease': False},
            {'tag_name': 'cli-v0.10.7', 'draft': False, 'prerelease': True},
            {'tag_name': 'cli-v0.9.99', 'draft': True, 'prerelease': False},
        ])
        self.state.write_text(json.dumps(releases))
        plan = self.plan()
        self.assertTrue(plan['changed'])
        self.assertEqual(plan['version'], '0.10.8')

    def test_later_page_failure_does_not_emit_a_plan_from_partial_releases(self):
        self.state.write_text(json.dumps([
            {'tag_name': 'cli-v0.8.3', 'draft': True, 'prerelease': False}
        ] * 31))
        self.failed_page.write_text('2')
        result = self.run_plan()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'plan.json').exists())
        self.assertFalse((self.root / 'outputs').exists())

    def test_oversized_release_metadata_still_refuses_planning(self):
        self.state.write_text(json.dumps([
            {'tag_name': 'x' * (1024 * 1024 + 1), 'draft': True, 'prerelease': False}
        ]))
        result = self.run_plan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Command output or execution bound exceeded', result.stderr)
        self.assertFalse((self.root / 'plan.json').exists())
        self.assertFalse((self.root / 'outputs').exists())

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

    def publication(self, corrupt=False, missing=False, superseded=False, immutable=True):
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
                                                       CORRUPT_DOWNLOAD=str(corrupt).lower(),
                                                       IMMUTABLE_RELEASE=str(immutable).lower()),
                                capture_output=True, text=True, timeout=30)
        return result, (self.root / 'default').read_text()

    def test_complete_verified_publication_advances_default(self):
        result, default = self.publication()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(default, 'cli-v0.1.0')

    def test_mutable_release_preserves_default(self):
        result, default = self.publication(immutable=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Release is not published and immutable', result.stderr)
        self.assertEqual(default, 'previous-release')

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
