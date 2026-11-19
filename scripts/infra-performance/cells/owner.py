"""Run or recover one protected, fully materialized frozen D1 Transaction comparison."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
from uuid import uuid4

from budget import Refused, admit, counts, today
from comparison import FIXTURE, boundaries, observe
from owner_bundle import MaterializedBundle, verified_batch, LOGIN, HISTORY
from owner_cloud import Cloud, ROLES
from owner_state import AccountExperiment, CustodyObject
from pilot import HERE, ROOT, NATIVE_API, NATIVE_BROWSER, confirmed, fetch, usage
from prepare import PIN

SUBJECT = '24000000-0000-4000-8000-000000000481'
ORIGIN = 'https://app.fidyapp.com'
TRIAL_MS = 7*24*60*60*1000


def prepare_inventory(owner, cloud):
    run = owner.available()
    if cloud.namespaces() or any(cloud.identity(role) is not None for role in ROLES):
        raise Refused('disposable_namespace_collision')
    for role in ROLES:
        owner.available()
        run['inventory'][role] = {'id':None}
        owner.save()
        cloud.create(role)
        identity = cloud.identity(role)
        if not identity:
            raise Refused('created_identity_unconfirmed')
        run['inventory'][role]['id'] = identity
        owner.save()


def teardown(owner, cloud, resumed=False):
    run = owner.active
    if run is None and owner.state['last'] and owner.state['last']['prefix'] == cloud.prefix:
        last = owner.state['last']
        if any(cloud.identity(role) is not None for role in last['removed']) or cloud.namespaces():
            raise Refused('retired_inventory_reappeared')
        return last
    if run is None or cloud.prefix != run['prefix']:
        raise Refused('cleanup_ownership_unavailable')
    if resumed and time.time() < run['deadline'] + 90:
        raise Refused('active_owner_may_still_be_running')
    run['cleaning'] = True
    owner.save()
    for role in reversed(ROLES):
        recorded = run['inventory'].get(role)
        if recorded is None:
            continue
        identity = cloud.identity(role)
        if recorded['id'] is None and identity is None and not resumed:
            raise Refused('uncertain_resource_creation_needs_recovery')
        if identity is not None:
            if recorded['id'] is not None and recorded['id'] != identity:
                raise Refused('owned_resource_replaced')
            cloud.remove(role, identity)
        if cloud.identity(role) is not None:
            raise Refused('disposal_unconfirmed')
    if cloud.namespaces():
        raise Refused('coordinator_disposal_unconfirmed')
    for role in run['inventory']:
        if cloud.identity(role) is not None:
            raise Refused('owned_inventory_survived')
    owner.state['last'] = dict(prefix=run['prefix'], day=run['day'], spent=run['spent'], pending=run['pending'],
                              removed=sorted(run['inventory']), namespacesAbsent=True)
    owner.state['active'] = None
    owner.save()
    return owner.state['last']


def statement(sql, *args):
    return dict(sql=sql, params=[str(value) for value in args])


def assert_equal(left, right, reason):
    if left != right:
        raise Refused(reason)


def exercise(owner, cloud, bundle, send, native, versions, key, pairs, report, save):
    db = owner.active['inventory']['db']['id']
    def batch(name, cap, stmts, check=None):
        return owner.batch(name, cap, lambda:verified_batch(cloud, db, stmts, check))
    for i, stmts in enumerate(bundle.batches):
        batch('materialize-'+str(i), bundle.direct[i], stmts)
    cloud.request('PUT', cloud.marker(), b'initial', 'application/octet-stream', raw=True)
    assert_equal(cloud.request('GET', cloud.marker(), raw=True), b'initial', 'generation_missing')
    now = int(time.time()*1000)
    batch('identity',bundle.direct[-3],[
        statement('UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=?,trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?',
                  'acceptance-portfolio', 'CO.Reference', now, now, now+TRIAL_MS, SUBJECT),
        statement("INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)",
                  uuid4(), SUBJECT, bundle.disclosure, 'disclosure', 'decision', now, now)])
    headers = {'Origin':ORIGIN, 'x-fidy-comparison-key':key}
    def request(route, body=None):
        method, path = route.split(' ',1)
        frame = []
        def dispatch():
            status, reply, data = send(method, path, headers, body)
            assert_equal(reply.get('x-fidy-comparison-worker'), versions['ingress'], 'unrecognized_ingress')
            frame.append((status,reply,data))
            return counts(json.loads(reply.get('x-fidy-comparison-cost','null')))
        owner.batch('inspect-original' if route.startswith('GET /transactions/') else route, bundle.http[route], dispatch)
        return frame[0]
    def successful(route, body=None):
        status, reply, data = request(route, body)
        assert_equal(status,200,'canonical_request_failed')
        return reply,json.loads(data)
    _, start = successful(LOGIN[0])
    batch('approval', bundle.direct[-2],[statement("UPDATE browser_login_pairings SET approval_portfolio_id=?,approval_message_id=?,approval_user_id=? WHERE id=? AND state='pending_approval' AND approval_message_id IS NULL",
                                       'acceptance-portfolio',uuid4(),SUBJECT,start['pairingId'])])
    reply,_ = successful(LOGIN[1],json.dumps({k:start[k] for k in ('pairingId','privateVerifier')}).encode())
    cookie = reply['set-cookie'].split(';',1)[0]
    if not cookie.startswith('__Host-fidy_session='):
        raise Refused('missing_fresh_session')
    headers['Cookie'] = cookie
    _, binding = successful(LOGIN[2])
    headers['Fidy-Session-Binding'] = binding['binding']
    for ident, expected in bundle.inspections.items():
        _, payload = successful('GET /transactions/'+ident)
        assert_equal(payload, expected, 'original_inspection_mismatch')
        time.sleep(1)
    def verify(body):
        assert_equal(json.loads(body),bundle.expected['history'],'effective_history_mismatch')
    for pair in range(pairs):
        for variant in (('do','d1') if pair % 2 else ('d1','do')):
            if variant == 'd1':
                def observation():
                    cost = None
                    def read(_, path):
                        nonlocal cost
                        status, reply, body = send('GET',path,headers,None)
                        if reply.get('x-fidy-comparison-worker') == versions['ingress']:
                            cost = counts(json.loads(reply.get('x-fidy-comparison-cost','null')))
                        return status,reply,body
                    row = observe(read, variant, pair, 0, time.monotonic(),'transactions.page',verify)
                    report['attempts'].append(row)
                    save()
                    return cost
                owner.batch('observe-history',bundle.http[HISTORY],observation)
            else:
                read = native()
                report['attempts'].append(observe(read,variant,pair,0,time.monotonic(),'transactions.page',verify))
                save()
            if not report['attempts'][-1]['ok']:
                raise Refused('observed_transaction_read_failed')
        time.sleep(1)
    def audit(replies):
        assert_equal(replies[0]['results'],[{'n':pairs}], 'audit_count_mismatch')
    batch('audit',bundle.direct[-1],[statement("SELECT count(*) AS n FROM audit_entries WHERE user_id=? AND operation='transactions.listTransactions' AND outcome='success'",SUBJECT)],audit)
    report.update(boundaries=boundaries(report['attempts'],pairs,1), verifiedHistoryAudits=pairs, verifiedInspections=8)


def native_read(session, revision):
    def sign():
        proof = subprocess.run(['bun',str(HERE/'sign.mjs')],input=json.dumps({**session,'revision':revision}),
                               cwd=ROOT,capture_output=True,text=True,timeout=15,check=True)
        if not proof.stdout:
            raise Refused('missing_native_proof')
        return proof.stdout
    def prepared():
        proof = sign()
        def read(_, path):
            return fetch(NATIVE_API+path, {'Origin':NATIVE_BROWSER,'Cookie':session['cookie'],
                      'Fidy-Session-Binding':session['binding'],'x-fidy-acceptance-proof':proof})
        return read
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('propose','run','cleanup'))
    for name in ('bundle','fixture','out'):
        parser.add_argument('--'+name,type=Path,required=(name=='out'))
    for name in ('prefix','revision','manifest-sha256'):
        parser.add_argument('--'+name,required=(name=='prefix'))
    parser.add_argument('--pairs',type=int,choices=(1,30),default=1)
    args = parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(parents=True,exist_ok=False)
    report = dict(status='missing', scope='isolated Transaction history', attempts=[], lifecycle='unobserved', acceptance='missing')
    def save():
        (args.out/'report.json').write_text(json.dumps(report,indent=2))
    save()
    try:
        if args.action != 'cleanup':
            sys.path.insert(0,str(HERE.parent/'canonical-fixture'))
            from hosted import verify_native_fixture, read_native_session
            proof = verify_native_fixture(args.fixture,revision=args.revision,resource_prefix=args.prefix)
            if proof['member'] != 'performance-1' or proof['resourcePrefix'] != args.prefix or proof['nativeRevision'] != args.revision:
                raise Refused('wrong_native_fixture_scope')
            bundle = MaterializedBundle(args.bundle,args.manifest_sha256,proof,args.pairs)
            session = read_native_session(args.fixture)
            if not all(session.get(k) for k in ('cookie','binding')):
                raise Refused('missing_native_session')
            report.update(maximum=bundle.estimate, pairs=args.pairs, packageSha256=args.manifest_sha256,
                          nativeRevision=args.revision, baseline=PIN)
            if args.action == 'propose':
                report['status'] = 'verified cost proposal'
                return 0
        account = os.environ['CLOUDFLARE_ACCOUNT_ID']
        cloud = Cloud(account,args.prefix)
        owner = AccountExperiment(CustodyObject(account),account)
        if args.action == 'cleanup':
            report['cleanup'] = teardown(owner,cloud,resumed=True)
        else:
            read = native_read(session,args.revision)
            decision = admit(ROOT,account,usage(account),bundle.estimate)
            owner.begin(args.prefix,decision,today())
            try:
                prepare_inventory(owner,cloud)
                key = secrets.token_urlsafe(40)
                active = owner.available()
                db = active['inventory']['db']['id']
                versions = cloud.deploy(bundle,db,key,active['deadline'])
                api = confirmed(dict(resourcePrefix=args.prefix,accountId=account,versions=versions,databaseId=db,
                                     fixture=FIXTURE,baseline=PIN,day=today()),account)
                def send(method,path,headers,body):
                    return fetch(api+path,{**headers,'Content-Type':'application/json'},body if method=='GET' or body else b'')
                exercise(owner,cloud,bundle,send,read,versions,key,args.pairs,report,save)
            finally:
                report['cleanup'] = teardown(owner,cloud)
        report['status'] = 'completed'
        return 0
    except Exception as error:
        report.update(status='stopped', reason=str(error) if isinstance(error,Refused) else type(error).__name__)
        return 1
    finally:
        save()


if __name__ == '__main__':
    raise SystemExit(main())
