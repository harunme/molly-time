"""Resumable catalogue enumeration. IDs come only from server catalogue lists."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
from urllib.parse import urlsplit

from api import Client, ROOT, PRIVATE


class Crawl:
    def __init__(self):
        self.client = Client()
        self.db = sqlite3.connect(PRIVATE / 'catalogue.sqlite')
        os.chmod(PRIVATE / 'catalogue.sqlite', 0o600)
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, body TEXT);
          CREATE TABLE IF NOT EXISTS series(id INTEGER PRIMARY KEY, body TEXT);
          CREATE TABLE IF NOT EXISTS episodes(id INTEGER PRIMARY KEY, series_id INTEGER, body TEXT, detail INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS episode_order(series_id INTEGER,episode_id INTEGER,position INTEGER,
                                                  PRIMARY KEY(series_id,episode_id));
          CREATE TABLE IF NOT EXISTS jobs(kind TEXT, key TEXT, params TEXT, state TEXT DEFAULT 'pending', error TEXT,
                                         PRIMARY KEY(kind,key));
          CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,url TEXT,kind TEXT,state TEXT DEFAULT 'pending',
                                              local_path TEXT,bytes INTEGER,sha256 TEXT,error TEXT);
          CREATE TABLE IF NOT EXISTS resource_links(resource_id TEXT,entity_type TEXT,entity_id INTEGER,field TEXT,
                                                    PRIMARY KEY(resource_id,entity_type,entity_id,field));
        ''')
        self.db.execute("UPDATE jobs SET state='pending' WHERE state='running'")
        self.enqueue('categories', '1', {'pageNo':'1','pageSize':'100'})
        self.db.commit()
        self.seed_observed_details()

    def seed_observed_details(self):
        for (raw,) in self.client.capture.execute("SELECT response_body FROM catalog_reads WHERE path IN ('/app-api/player/video-diversity/get2','/app-api/player/video-diversity/get-first2') AND status=200"):
            value = self.client.decode(raw)
            if value.get('code') != 0 or not isinstance(value.get('data'),dict):
                continue
            item = value['data']
            if not isinstance(item.get('id'),int) or not isinstance(item.get('videoId'),int):
                continue
            self.db.execute('INSERT OR REPLACE INTO episodes VALUES (?,?,?,1)',
                            (item['id'],item['videoId'],json.dumps(item,ensure_ascii=False)))
            self.urls('episode',item)
            self.enqueue('detail',item['id'],{'id':str(item['id']),'type':'2'})
            self.db.execute("UPDATE jobs SET state='done' WHERE kind='detail' AND key=?",(str(item['id']),))
        self.db.commit()

    def enqueue(self, kind, key, params):
        self.db.execute('INSERT OR IGNORE INTO jobs(kind,key,params) VALUES (?,?,?)',
                        (kind, str(key), json.dumps(params)))

    def urls(self, entity_type, item):
        fields = {'imgUrl':'cover', 'videoUrl':'video', 'srtEnUrl':'subtitle', 'srtCnEnUrl':'subtitle'}
        for field, kind in fields.items():
            url = item.get(field)
            if not isinstance(url,str) or not url.startswith(('http://','https://')):
                continue
            parsed = urlsplit(url)
            if parsed.username or parsed.password or not parsed.hostname:
                continue
            key = hashlib.sha256(url.encode()).hexdigest()
            self.db.execute('INSERT OR IGNORE INTO resources(id,url,kind) VALUES (?,?,?)',(key,url,kind))
            self.db.execute('INSERT OR IGNORE INTO resource_links VALUES (?,?,?,?)',
                            (key,entity_type,item['id'],field))

    def page(self, kind, params, data):
        if not isinstance(data,dict) or not isinstance(data.get('list'),list) or not isinstance(data.get('total'),int):
            raise ValueError('Unexpected page schema')
        items = data['list']
        number, size = int(params['pageNo']), int(params['pageSize'])
        if number * size < data['total']:
            if not items:
                raise ValueError('Empty page before declared total')
            nxt = dict(params, pageNo=str(number+1))
            parent = params.get('sortId', params.get('videoId', ''))
            self.enqueue(kind, f'{parent}:{number+1}', nxt)
        return items

    def execute(self, kind, params):
        paths = {'categories':'video-category/page','series':'video-info/page',
                 'episodes':'video-diversity/page','detail':'video-diversity/get2'}
        data = self.client.read('/app-api/player/'+paths[kind], params)
        items = [data] if kind == 'detail' else self.page(kind,params,data)
        for index,item in enumerate(items):
            if not isinstance(item,dict) or not isinstance(item.get('id'),int):
                raise ValueError('Item lacks an integer server ID')
            body = json.dumps(item,ensure_ascii=False)
            if kind == 'categories':
                self.db.execute('INSERT OR REPLACE INTO categories VALUES (?,?)',(item['id'],body))
                self.enqueue('series', f"{item['id']}:1", {'sortId':str(item['id']),'pageNo':'1','pageSize':'100'})
            elif kind == 'series':
                self.db.execute('INSERT OR REPLACE INTO series VALUES (?,?)',(item['id'],body))
                self.urls('series',item)
                self.enqueue('episodes',f"{item['id']}:1",{'videoId':str(item['id']),'pageNo':'1','pageSize':'500'})
            else:
                if kind == 'detail' and item['id'] != int(params['id']):
                    raise ValueError('Detail ID mismatch')
                self.db.execute('''INSERT INTO episodes VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                                   body=CASE WHEN excluded.detail=1 OR episodes.detail=0 THEN excluded.body ELSE episodes.body END,
                                   detail=MAX(episodes.detail,excluded.detail)''',
                                (item['id'],item['videoId'],body,int(kind=='detail')))
                self.urls('episode',item)
                if kind == 'episodes':
                    position=(int(params['pageNo'])-1)*int(params['pageSize'])+index+1
                    self.db.execute('INSERT OR REPLACE INTO episode_order VALUES (?,?,?)',
                                    (item['videoId'],item['id'],position))
                    self.enqueue('detail',item['id'],{'id':str(item['id']),'type':'2'})

    def status(self):
        out={'updated_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),
             'categories':self.db.execute('select count(*) from categories').fetchone()[0],
             'series':self.db.execute('select count(*) from series').fetchone()[0],
             'episodes':self.db.execute('select count(*) from episodes').fetchone()[0],
             'episode_details':self.db.execute('select count(*) from episodes where detail=1').fetchone()[0],
             'jobs':{s:n for s,n in self.db.execute('select state,count(*) from jobs group by state')},
             'resources':{k:n for k,n in self.db.execute('select kind,count(*) from resources group by kind')},
             'catalogue_complete':not self.db.execute("select 1 from jobs where state!='done' limit 1").fetchone()}
        tmp=ROOT/'status.json.tmp';tmp.write_text(json.dumps(out,ensure_ascii=False,indent=2));tmp.replace(ROOT/'status.json')
        return out

    def run(self, details=True, on_step=None):
        last=0
        while True:
            clause='' if details else "AND kind!='detail'"
            row=self.db.execute(f"SELECT kind,key,params FROM jobs WHERE state='pending' {clause} ORDER BY CASE kind WHEN 'categories' THEN 0 WHEN 'series' THEN 1 WHEN 'episodes' THEN 2 ELSE 3 END,key LIMIT 1").fetchone()
            if not row:break
            kind,key,raw=row
            self.db.execute("UPDATE jobs SET state='running' WHERE kind=? AND key=?",(kind,key));self.db.commit()
            error=None
            for attempt in range(3):
                try:
                    self.execute(kind,json.loads(raw));error=None;break
                except Exception as exc:
                    self.db.rollback()
                    # Exception messages never contain request headers or payloads.
                    error=f'{type(exc).__name__}: {str(exc)[:200]}'
                    if 'API refused' in error:break
                    delay = [60,180,600][attempt]
                    if isinstance(exc,urllib.error.HTTPError):
                        try:delay=max(delay,min(3600,int(exc.headers.get('Retry-After','0'))))
                        except ValueError:pass
                    self.status()
                    time.sleep(delay)
            self.db.execute('UPDATE jobs SET state=?,error=? WHERE kind=? AND key=?',
                            ('failed' if error else 'done',error,kind,key));self.db.commit()
            if on_step:
                on_step()
            if time.monotonic()-last>20:
                print(json.dumps(self.status(),ensure_ascii=False),flush=True);last=time.monotonic()
            if error and any(x in error for x in ['code=401','code=403','code=100200']):
                break
        print(json.dumps(self.status(),ensure_ascii=False),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--catalogue-only',action='store_true');args=p.parse_args()
    Crawl().run(details=not args.catalogue_only)
