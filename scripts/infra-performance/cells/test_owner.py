import copy
import unittest

from budget import Refused, today
from owner_state import AccountExperiment


class ConditionalObject:
    def __init__(self):
        self.value = None
        self.version = 0

    def read(self):
        return self.version, copy.deepcopy(self.value)

    def replace(self, version, value):
        if version != self.version:
            raise Refused('stale account ledger')
        self.value = copy.deepcopy(value)
        self.version += 1
        return self.version


class OwnerTests(unittest.TestCase):
    def test_interrupted_reservation_survives_runner_loss_and_refuses_replay(self):
        obj = ConditionalObject()
        account, prefix = 'a' * 32, 'fidy-2259-123456abcdef'
        maximum = dict(rowsRead=18000, rowsWritten=4754)
        decision = dict(_tag='Allowed', maximumRowsRead=18000, maximumRowsWritten=4754)
        first = AccountExperiment(obj, account)
        contender = AccountExperiment(obj, account)
        first.begin(prefix, decision, today())
        with self.assertRaises(Refused):
            contender.begin('fidy-2259-abcdef123456', decision, today())
        def lost():
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            first.batch('materialize-0', maximum, lost)
        restored = AccountExperiment(obj, account)
        self.assertEqual(restored.active['pending']['name'], 'materialize-0')
        with self.assertRaises(Refused):
            restored.batch('materialize-0', maximum, lambda: self.fail('replayed'))
        with self.assertRaises(Refused):
            restored.begin('fidy-2259-abcdef123456', decision, today())

    def test_cleaned_uncertain_read_cannot_be_retried_under_another_name(self):
        from owner import teardown
        from types import SimpleNamespace

        account, prefix = 'a'*32, 'fidy-2259-123456abcdef'
        obj = ConditionalObject()
        owner = AccountExperiment(obj,account)
        decision = dict(_tag='Allowed', maximumRowsRead=200, maximumRowsWritten=20)
        owner.begin(prefix, decision, today())
        with self.assertRaises(Refused):
            owner.batch('history', dict(rowsRead=90,rowsWritten=9), lambda:None)
        teardown(owner, SimpleNamespace(prefix=prefix,verify_absent=lambda *_: None))
        fresh = AccountExperiment(obj,account)
        with self.assertRaises(Refused):
            fresh.begin('fidy-2259-abcdef123456',decision,today())

    def test_reconciled_work_and_another_run_share_the_full_account_estimate(self):
        from owner import teardown
        from types import SimpleNamespace

        account, prefix = 'a'*32, 'fidy-2259-123456abcdef'
        obj = ConditionalObject()
        first = AccountExperiment(obj,account)
        first.begin(prefix,dict(_tag='Allowed',maximumRowsRead=200,maximumRowsWritten=20),today())
        first.batch('history',dict(rowsRead=100,rowsWritten=12),lambda:dict(rowsRead=44,rowsWritten=5))
        teardown(first,SimpleNamespace(prefix=prefix,verify_absent=lambda *_: None))
        next_run = AccountExperiment(obj,account)
        self.assertEqual(next_run.full_estimate(dict(rowsRead=100,rowsWritten=20), today()),
                         dict(rowsRead=144,rowsWritten=25))
        next_run.begin('fidy-2259-abcdef123456',dict(_tag='Allowed',maximumRowsRead=144,maximumRowsWritten=25),today())
        with self.assertRaises(Refused):
            next_run.batch('outside-ceiling',dict(rowsRead=100,rowsWritten=21),lambda:self.fail('dispatched'))

    def test_rejected_create_cannot_dispose_the_colliding_database(self):
        from owner import prepare_inventory, teardown
        from owner_cloud import NameConflict
        class Conflict:
            prefix = 'fidy-2259-123456abcdef'
            db = None
            def namespaces(self):
                return []
            def identity(self, role):
                return self.db if role == 'db' else None
            def verify_absent(self, owned, ids):
                assert not owned and not ids
            def create(self, role):
                self.db = 'another-controller'
                raise NameConflict('collision')
            def remove(self, *_):
                raise AssertionError('Removed the other controller’s database')
        cloud = Conflict()
        owner = AccountExperiment(ConditionalObject(), 'a'*32)
        owner.begin(cloud.prefix,dict(_tag='Allowed',maximumRowsRead=100,maximumRowsWritten=10), today())
        with self.assertRaises(NameConflict):
            prepare_inventory(owner,cloud)
        self.assertEqual(teardown(owner,cloud)['removed'],[])
        self.assertEqual(cloud.db,'another-controller')

    def test_lost_create_reply_is_discovered_by_name_and_verified_by_uuid(self):
        import io
        import json
        from unittest.mock import patch
        from urllib.error import HTTPError
        from owner import prepare_inventory, teardown
        from owner_cloud import Cloud

        prefix, account = 'fidy-2259-123456abcdef','a'*32
        uuid = '01111111-1111-4111-8111-111111111111'
        class Control:
            stored = None
            checked_uuid = False
            def open(self, req, timeout):
                path = req.selector.split('/'+account+'/')[1]
                def missing():
                    raise HTTPError(req.full_url,404,'absent',{},io.BytesIO(b''))
                if path.startswith('workers/durable_objects/namespaces?'):
                    wire = dict(result=[],result_info=dict(page=1,total_pages=1))
                elif path == 'd1/database?name='+prefix:
                    wire = dict(result=[self.stored] if self.stored else [])
                elif path == 'd1/database' and req.method == 'POST':
                    assert json.loads(req.data) == dict(name=prefix)
                    self.stored = dict(name=prefix,uuid=uuid)
                    raise TimeoutError('acknowledgement interrupted')
                elif path == 'd1/database/'+uuid:
                    if req.method == 'DELETE':
                        self.stored = None
                        wire = dict(result={})
                    else:
                        self.checked_uuid = True
                        missing()
                elif req.method == 'GET' and (path.endswith('/script-settings') or path == 'r2/buckets/'+prefix):
                    missing()
                else:
                    raise AssertionError(path)
                wire['success'] = True
                result = io.BytesIO(json.dumps(wire).encode())
                result.status = 200
                return result
        with patch.dict('os.environ',CLOUDFLARE_API_TOKEN='fixture'):
            cloud = Cloud(account,prefix)
        cloud.transport = Control()
        store = ConditionalObject()
        experiment = AccountExperiment(store,account)
        experiment.begin(prefix,dict(_tag='Allowed',maximumRowsRead=100,maximumRowsWritten=10),today())
        with self.assertRaises(TimeoutError):
            prepare_inventory(experiment,cloud)
        restored = AccountExperiment(store,account)
        with patch('owner.time.time',return_value=restored.active['deadline']+91):
            self.assertEqual(teardown(restored,cloud,resumed=True)['removed'],['db'])
        self.assertIsNone(cloud.transport.stored)
        self.assertTrue(cloud.transport.checked_uuid)
