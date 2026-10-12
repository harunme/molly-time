"""Authenticated, read-only BBKT API client using observed app encoding.

Credentials and codec material are loaded only from the private capture folder.
This client has no login, account mutation, payment, or activation methods.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
import sqlite3
import time
import random
import urllib.request

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

ROOT = Path(__file__).resolve().parent
PRIVATE = ROOT / '.private'
CATALOG_DB = PRIVATE / 'catalogue.sqlite'
ALLOWED = {
    '/app-api/player/user-category/get',
    '/app-api/player/video-category/page',
    '/app-api/player/video-info/page',
    '/app-api/player/video-diversity/page',
    '/app-api/player/video-diversity/get2',
    '/app-api/player/video-diversity/get-first2',
    '/app-api/player/recommend-info/page',
}


class Client:
    def __init__(self):
        self.codecs = json.loads((PRIVATE / 'api-codec.json').read_text())
        self.capture = sqlite3.connect(PRIVATE / 'capture.sqlite')
        row = self.capture.execute(
            'SELECT request_headers FROM catalog_reads WHERE status=200 ORDER BY seen DESC LIMIT 1'
        ).fetchone()
        if not row:
            raise RuntimeError('No observed successful catalogue request')
        headers = json.loads(row[0])
        self.headers = {k: v for k, v in headers.items() if k.lower() not in
                        {'host', 'content-length', 'connection', 'accept-encoding'}}
        self.headers['Accept-Encoding'] = 'identity'
        self.opener = urllib.request.build_opener()
        self.request_count = 0
        self.policy = json.loads((ROOT / 'rate-policy.json').read_text())

    def cipher(self, direction):
        config = self.codecs[direction]
        if config['mode'] != 'ECB':
            raise RuntimeError('Unvalidated codec')
        return Cipher(algorithms.AES(config['key'].encode()), modes.ECB())

    def encode(self, value):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        padder = PKCS7(128).padder()
        padded = padder.update(data) + padder.finalize()
        enc = self.cipher('request').encryptor()
        return base64.b64encode(enc.update(padded) + enc.finalize())

    def decode(self, body):
        try:
            return json.loads(body)
        except (ValueError, UnicodeError):
            pass
        dec = self.cipher('response').decryptor()
        padded = dec.update(base64.b64decode(body, validate=True)) + dec.finalize()
        unpadder = PKCS7(128).unpadder()
        return json.loads(unpadder.update(padded) + unpadder.finalize())

    def read(self, path, params):
        if path not in ALLOWED:
            raise ValueError('Endpoint is not an approved catalogue read')
        # A single client browses at a human pace, with a break every ten reads.
        if self.request_count and self.request_count % self.policy['reads_per_batch'] == 0:
            time.sleep(random.uniform(*self.policy['batch_rest_seconds']))
        time.sleep(random.uniform(*self.policy['api_gap_seconds']))
        self.request_count += 1
        req = urllib.request.Request('https://bbketang.com' + path,
                                     data=self.encode(params), headers=self.headers, method='POST')
        with self.opener.open(req, timeout=30) as response:
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise RuntimeError('Response exceeds catalogue limit')
        value = self.decode(body)
        if value.get('code') != 0:
            raise RuntimeError(f"API refused catalogue read, code={value.get('code')}")
        return value['data']


if __name__ == '__main__':
    client = Client()
    data = client.read('/app-api/player/video-category/page', {'pageNo': '1', 'pageSize': '100'})
    target = PRIVATE / 'server-categories.json'
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    target.chmod(0o600)
    print(json.dumps({'saved': target.name, 'type': type(data).__name__,
                      'count': len(data) if isinstance(data, (list, dict)) else None,
                      'keys': list(data) if isinstance(data, dict) else None}, ensure_ascii=False))
