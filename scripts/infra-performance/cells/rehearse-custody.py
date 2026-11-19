"""Exercise the actual S3 CLI transport and its conditional headers on a credential-free runner."""
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from threading import Thread
from unittest.mock import patch
from types import SimpleNamespace

from budget import Refused
from owner_state import BUCKET, CustodyObject


def main():
    account = 'a' * 32
    prefix = f'/{BUCKET}/protected-storage/account/{account}/d1-ledger.json'
    current = {}

    class Object(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def failure(self, status, code):
            reply = f'<Error><Code>{code}</Code><Message>fixture</Message></Error>'.encode()
            self.send_response(status)
            self.send_header('Content-Type','application/xml')
            self.send_header('Content-Length',str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def validate(self):
            assert self.path == prefix
            assert self.headers['Authorization'].startswith('AWS4-HMAC-SHA256 ')
            jwt = base64.b64decode(self.headers['X-Amz-Security-Token'])
            assert jwt.startswith(b'jwt/')
            head, payload, sig = jwt[4:].split(b'.')
            decode = lambda raw: base64.urlsafe_b64decode(raw+b'='*(-len(raw)%4))
            claims = json.loads(decode(payload))
            assert claims['actions'] == ['GetObject','PutObject'] and claims['bucket'] == BUCKET
            assert claims['paths'] == {'prefixPaths':[], 'objectPaths':[prefix.split('/',2)[2]]}
            assert claims['aud'] == account+'.r2.cloudflarestorage.com' and claims['iss'] == 'b'*32
            key = hashlib.sha256(b'fixture').hexdigest().encode()
            assert hmac.compare_digest(decode(sig), hmac.digest(key, head+b'.'+payload, 'sha256'))

        def do_GET(self):
            self.validate()
            if not current:
                return self.failure(404,'NoSuchKey')
            self.send_response(200)
            self.send_header('ETag', current['etag'])
            self.send_header('Content-Length',str(len(current['data'])))
            self.end_headers()
            self.wfile.write(current['data'])

        def do_PUT(self):
            self.validate()
            if current and self.headers.get('If-Match') != current['etag']:
                return self.failure(412,'PreconditionFailed')
            if not current and self.headers.get('If-None-Match') != '*':
                return self.failure(412,'PreconditionFailed')
            data = self.rfile.read(int(self.headers['Content-Length']))
            json.loads(data)
            current.update(data=data, etag='"' + hashlib.sha256(data).hexdigest() + '"')
            self.send_response(200)
            self.send_header('ETag', current['etag'])
            self.send_header('Content-Length','0')
            self.end_headers()

    def verify(method, path):
        assert (method,path) == ('GET','tokens/verify')
        return {'status':'active','id':'b'*32}
    cloud = SimpleNamespace(auth='fixture',result=verify)
    with patch.dict(os.environ, GITHUB_ACTIONS='true',GITHUB_REF='refs/heads/trunk',
                    GITHUB_REPOSITORY='B4rz99/fidy-ai',GITHUB_REF_PROTECTED='true'):
        first, other = CustodyObject(account,cloud), CustodyObject(account,cloud)
    with ThreadingHTTPServer(('127.0.0.1',0),Object) as server:
        thread = Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            for client in (first,other):
                client.command[2] = 'http://127.0.0.1:'+str(server.server_port)
            assert first.read() == (None,None)
            token = first.replace(None,{'state':'reserved'})
            assert other.read() == (token,{'state':'reserved'})
            first.replace(token,{'state':'pending'})
            for stale in (None,token):
                try:
                    other.replace(stale,{'state':'replayed'})
                    raise AssertionError('Stale account writer succeeded')
                except Refused:
                    pass
            assert other.read()[1] == {'state':'pending'}
        finally:
            server.shutdown()
            thread.join()


if __name__ == '__main__':
    main()
