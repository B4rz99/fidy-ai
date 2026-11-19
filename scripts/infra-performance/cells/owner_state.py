"""One conditional R2 object serializes all protected D1 experiments on this account."""
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path

from budget import KEYS, Refused, counts, today

BUCKET = 'fidy-native-release-smoke'
LIFETIME = 20 * 60


class CustodyObject:
    def __init__(self, account):
        if not re.fullmatch('[a-f0-9]{32}', account):
            raise Refused('missing_account_binding')
        self.key = f'protected-storage/account/{account}/d1-ledger.json'
        self.command = ['aws', '--endpoint-url', f'https://{account}.r2.cloudflarestorage.com',
                        '--region', 'auto', '--no-cli-pager', 's3api']
        self.env = {key: os.environ[key] for key in ('PATH', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')}
        if 'AWS_SESSION_TOKEN' in os.environ:
            self.env['AWS_SESSION_TOKEN'] = os.environ['AWS_SESSION_TOKEN']
        self.env.update(AWS_MAX_ATTEMPTS='1', AWS_EC2_METADATA_DISABLED='true')

    def call(self, operation, *args):
        return subprocess.run([*self.command, operation, '--bucket', BUCKET, '--key', self.key, *args],
                              capture_output=True, env=self.env, timeout=30)

    def read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, 'ledger')
            reply = self.call('get-object', str(path))
            if reply.returncode:
                if b'(NoSuchKey)' in reply.stderr:
                    return None, None
                raise Refused('account_ledger_unavailable')
            return json.loads(reply.stdout)['ETag'], json.loads(path.read_text())

    def replace(self, version, value):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, 'ledger')
            path.write_text(json.dumps(value))
            condition = ['--if-match', version] if version else ['--if-none-match', '*']
            reply = self.call('put-object', '--body', str(path), *condition)
            if reply.returncode:
                raise Refused('account_ledger_changed_or_unavailable')
            return json.loads(reply.stdout)['ETag']


class AccountExperiment:
    def __init__(self, store, account):
        self.store = store
        self.version, state = store.read()
        self.state = state if state is not None else dict(account=account, active=None, charged={}, last=None)
        if self.state['account'] != account:
            raise Refused('foreign_account_ledger')

    @property
    def active(self):
        return self.state['active']

    def save(self):
        # Vary each representation even if a later transition restores an earlier logical state.
        self.state['transition'] = secrets.token_hex(16)
        self.version = self.store.replace(self.version, self.state)

    def begin(self, prefix, decision, day):
        if (self.active is not None or self.state['charged'].get('day') == day or day != today()
                or decision.get('_tag') != 'Allowed' or not re.fullmatch('fidy-2259-[0-9a-f]{12}', prefix)):
            raise Refused('account_experiment_unavailable')
        limit = counts(dict(rowsRead=decision['maximumRowsRead'], rowsWritten=decision['maximumRowsWritten']))
        self.state['active'] = dict(prefix=prefix, deadline=int(time.time()) + LIFETIME, day=day, limit=limit,
                                    spent=dict(rowsRead=0, rowsWritten=0), inventory={}, pending=None, cleaning=False)
        # Hold the entire admitted ceiling through midnight, including lost replies and analytics lag.
        self.state['charged'] = dict(day=day, maximum=limit)
        self.save()

    def available(self):
        run = self.active
        if (not run or run['cleaning'] or run['pending'] is not None or run['day'] != today()
                or int(time.time()) >= run['deadline']):
            raise Refused('account_experiment_fenced')
        return run

    def batch(self, name, maximum, operation):
        run, maximum = self.available(), counts(maximum)
        if any(run['spent'][k] + maximum[k] > run['limit'][k] for k in KEYS):
            raise Refused('remaining_reservation_exhausted')
        run['pending'] = dict(name=name, maximum=maximum)
        self.save()
        actual = counts(operation())
        if any(actual[k] > maximum[k] for k in KEYS) or today() != run['day']:
            raise Refused('observed_cost_outside_reservation')
        run['spent'] = {k: run['spent'][k] + actual[k] for k in KEYS}
        run['pending'] = None
        self.save()
        return actual
