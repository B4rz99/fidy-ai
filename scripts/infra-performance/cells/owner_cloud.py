"""Cloudflare control plane for a single disposable Transaction comparator."""
import json
import os
import re
import secrets
import urllib.error
import urllib.request
from uuid import UUID

from budget import Refused
from owner_transport import NoRedirect
from prepare import PIN

CLASS = 'UserTransactionCoordinator'
ROLES = ('db', 'bucket', 'core', 'ingress')
INERT = b'export default {fetch(){return new Response(null,{status:403})}}'


def multipart(metadata, module):
    boundary = secrets.token_hex(24)
    def part(name, content_type, value):
        return (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\n'
                f'Content-Type: {content_type}\r\n\r\n').encode() + value + b'\r\n'
    data = (part('metadata', 'application/json', json.dumps(metadata).encode())
            + part('index.mjs', 'application/javascript+module', module) + f'--{boundary}--\r\n'.encode())
    return data, 'multipart/form-data; boundary=' + boundary


class Cloud:
    def __init__(self, account, prefix):
        if not re.fullmatch('[a-f0-9]{32}', account) or not re.fullmatch('fidy-2259-[0-9a-f]{12}', prefix):
            raise Refused('invalid_resource_scope')
        self.root = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/'
        self.prefix = prefix
        self.auth = os.environ['CLOUDFLARE_API_TOKEN']
        self.transport = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def request(self, method, path, body=None, kind='application/json', tolerate_absent=False, raw=False, headers=None):
        data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.root + path, method=method, data=data,
                    headers={'Authorization': 'Bearer ' + self.auth, 'Content-Type': kind, **(headers or {})})
        try:
            response = self.transport.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            if error.code == 404 and tolerate_absent:
                return None
            raise Refused('cloud_control_' + str(error.code)) from None
        with response:
            if response.status == 204 and method == 'DELETE' and not raw:
                return dict(success=True, result=None)
            content = response.read(16_000_001)
        if len(content) > 16_000_000:
            raise Refused('control_response_too_large')
        if raw:
            return content
        wire = json.loads(content)
        if wire.get('success') is not True:
            raise Refused('unconfirmed_control_operation')
        return wire

    def result(self, method, path, *args, **kwargs):
        data = self.request(method, path, *args, **kwargs)
        return None if data is None else data['result']

    def worker(self, role):
        if role not in ('ingress', 'core'):
            raise Refused('unexpected_worker_scope')
        return 'workers/scripts/' + self.prefix + '-' + role

    def identity(self, role):
        if role == 'db':
            entries = self.result('GET', 'd1/database?name=' + self.prefix)
            selected = [d for d in entries if d['name'] == self.prefix]
            if len(selected) > 1:
                raise Refused('ambiguous_database')
            return str(UUID(selected[0]['uuid'])) if selected else None
        if role == 'bucket':
            bucket = self.result('GET', 'r2/buckets/' + self.prefix, tolerate_absent=True)
            if bucket is None:
                return None
            if bucket['name'] != self.prefix:
                raise Refused('foreign_bucket')
            return bucket['creation_date']
        settings = self.result('GET', self.worker(role) + '/script-settings', tolerate_absent=True)
        if settings is None:
            return None
        if self.prefix not in settings.get('tags', []):
            raise Refused('foreign_worker')
        return self.prefix + '-' + role

    def namespaces(self):
        found = []
        for page in range(1, 101):
            wire = self.request('GET', f'workers/durable_objects/namespaces?page={page}&per_page=100')
            for item in wire['result']:
                if item.get('script') == self.prefix + '-core':
                    if item['class'] != CLASS:
                        raise Refused('foreign_coordinator')
                    found.append(item['id'])
            info = wire['result_info']
            if info['page'] != page:
                raise Refused('incomplete_namespace_inventory')
            if page >= info['total_pages']:
                return found
        raise Refused('unbounded_namespace_inventory')

    def upload(self, role, module, bindings=(), migrations=None, new=False):
        metadata = dict(main_module='index.mjs', bindings=list(bindings), tags=[self.prefix], compatibility_date='2026-09-08',
                        compatibility_flags=['enable_request_signal', 'request_signal_passthrough', 'nodejs_compat'],
                        observability=dict(enabled=False))
        if migrations:
            metadata['migrations'] = migrations
        body, kind = multipart(metadata, module)
        self.result('PUT', self.worker(role), body, kind, headers={'If-None-Match':'*'} if new else None)

    def expose(self, role, enabled):
        addr = self.worker(role) + '/subdomain'
        self.result('POST', addr, dict(enabled=enabled, previews_enabled=False))
        state = self.result('GET', addr)
        if state.get('enabled') is not enabled or state.get('previews_enabled') is not False:
            raise Refused('unexpected_worker_exposure')

    def create(self, role):
        if role == 'db':
            self.result('POST', 'd1/database', dict(name=self.prefix))
        elif role == 'bucket':
            self.result('POST', 'r2/buckets', dict(name=self.prefix))
        else:
            self.upload(role, INERT, new=True)
            self.expose(role, False)

    def deploy(self, bundle, db, key, deadline):
        common = [dict(type='plain_text', name=k, text=v) for k, v in {
            'RELEASE_GIT_SHA':PIN, 'BROWSER_ORIGIN':'https://app.fidyapp.com', 'CONTRACT_DIGEST':bundle.contract,
        }.items()]
        coordinator = dict(type='durable_object_namespace', class_name=CLASS)
        core = [*common, dict(type='d1', name='DB', id=db), dict(type='r2_bucket', name='ERASURE_BUCKET', bucket_name=self.prefix),
                dict(coordinator, name='USER_TRANSACTION_COORDINATOR'), dict(coordinator, name='ERASURE_REGISTRY_COORDINATOR')]
        core.extend(dict(type='plain_text', name=k, text=v) for k,v in {
            'ERASURE_REQUIRED':'true','OPENAI_API_KEY':'','HOSTED_AI_MODEL':'unused','WHATSAPP_BUSINESS_PORTFOLIO_ID':'acceptance-portfolio'}.items())
        self.upload('core', bundle.modules['metered-core'], core, dict(new_tag='isolated', new_sqlite_classes=[CLASS]))
        ingress = [*common, dict(type='service', name='CORE', service=self.prefix + '-core'),
                   dict(coordinator, name='ERASURE_REGISTRY_COORDINATOR', script_name=self.prefix+'-core'),
                   dict(type='version_metadata', name='CF_VERSION_METADATA'),
                   dict(type='secret_text', name='EXPERIMENT_KEY', text=key),
                   dict(type='secret_text', name='PAT_ADMISSION_KEY', text=secrets.token_urlsafe(40)),
                   dict(type='plain_text', name='LOCAL_CANONICAL_READ_BEARER', text=''),
                   dict(type='plain_text', name='EXPERIMENT_DEADLINE', text=str(deadline*1000))]
        self.upload('ingress', bundle.modules['bounded-ingress'], ingress)
        self.expose('ingress', True)
        versions = {}
        for role in ('core','ingress'):
            item = self.result('GET', self.worker(role)+'/deployments')['deployments'][0]
            entry, = item['versions']
            if entry['percentage'] != 100:
                raise Refused('split_worker_deployment')
            versions[role] = str(UUID(entry['version_id']))
        return versions

    def query(self, db, statements):
        return self.result('POST', 'd1/database/'+str(UUID(db))+'/query',
                           dict(batch=[dict(sql=s['sql'], params=s['params']) for s in statements]))

    def marker(self):
        return 'r2/buckets/'+self.prefix+'/objects/recovery/generation'

    def remove(self, role, identity):
        if role == 'db':
            self.result('DELETE','d1/database/'+str(UUID(identity)))
        elif role == 'bucket':
            if self.request('GET', self.marker(), raw=True, tolerate_absent=True) is not None:
                self.request('DELETE', self.marker(), raw=True)
            self.result('DELETE','r2/buckets/'+self.prefix)
        else:
            self.expose(role, False)
            if role == 'core' and self.namespaces():
                self.upload('core', INERT, migrations=dict(old_tag='isolated', new_tag='retired', deleted_classes=[CLASS]))
            self.result('DELETE',self.worker(role))
