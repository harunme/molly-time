"""Deterministic programme folder layout and offline application catalogue."""
from __future__ import annotations
import json
import os
import sqlite3
from pathlib import Path
import re
import unicodedata
from api import ROOT

DOWNLOADS=ROOT.parents[1]/'downloads'/'bbkt'
CATALOG_DB = ROOT / '.private' / 'catalogue.sqlite'


def safe_name(value):
    value=unicodedata.normalize('NFC',str(value))
    value=re.sub(r'[\x00-\x1f/\\:*?"<>|]', '_', value).strip(' .')
    while len(value.encode('utf8'))>150:
        value=value[:-1]
    return value or '未命名'


class Layout:
    def __init__(self,db=None):
        self.db=db
        self.root=DOWNLOADS
        self.root.mkdir(parents=True,exist_ok=True)

    def _connect(self):
        """Open a fresh connection in the current thread for safe concurrent use."""
        import sqlite3
        from api import CATALOG_DB
        conn = sqlite3.connect(str(CATALOG_DB), timeout=30)
        return conn

    def series_dir(self,series_id,db=None):
        db=db or self.db
        row=db.execute('SELECT body FROM series WHERE id=?',(series_id,)).fetchone()
        if not row:return None
        series=json.loads(row[0]);cid=series.get('sortId')
        row=db.execute('SELECT body FROM categories WHERE id=?',(cid,)).fetchone()
        category=json.loads(row[0]) if row else {'name':'未分类','id':cid}
        return Path(safe_name(category['name']))/f"{safe_name(series['name'])} [{series_id}]"

    def episode_dir(self,episode_id,db=None):
        db=db or self.db
        row=db.execute('SELECT series_id,body FROM episodes WHERE id=?',(episode_id,)).fetchone()
        if not row:return None
        sid,raw=row;series=self.series_dir(sid,db)
        if series is None:return None
        item=json.loads(raw)
        return series/f"{safe_name(item.get('nameNew') or item['name'])} [{episode_id}]"

    def links(self,resource_id,extension,db=None):
        # Open a fresh connection in the calling thread when self.db was created in
        # another thread; SQLite connections are not safe to share across threads.
        if db is None:
            if self.db is None:
                conn = self._connect()
                own = True
            else:
                try:
                    self.db.execute('SELECT 1').fetchone()
                    conn = self.db
                    own = False
                except sqlite3.ProgrammingError:
                    conn = self._connect()
                    own = True
        else:
            conn = db
            own = False
        try:
            out=[]
            for entity,eid,field in conn.execute('SELECT entity_type,entity_id,field FROM resource_links WHERE resource_id=?',(resource_id,)):
                base=self.series_dir(eid,conn) if entity=='series' else self.episode_dir(eid,conn)
                if base is None:continue
                names={'imgUrl':'封面','videoUrl':'视频','srtEnUrl':'英文字幕','srtCnEnUrl':'中英字幕'}
                out.append(base/(names[field]+extension))
            return out
        finally:
            if own:
                conn.close()

    def place(self,resource_id,source):
        import os
        source=Path(source)
        for relative in self.links(resource_id,source.suffix):
            target=self.root/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            if not target.exists():
                os.link(source,target)

    def create_folders(self):
        for (cid,raw) in self.db.execute('SELECT id,body FROM categories'):
            (self.root/safe_name(json.loads(raw)['name'])).mkdir(parents=True,exist_ok=True)
        for (sid,) in self.db.execute('SELECT id FROM series'):
            path=self.series_dir(sid)
            if path:(self.root/path).mkdir(parents=True,exist_ok=True)

    def export(self):
        categories=[json.loads(r[0]) for r in self.db.execute('SELECT body FROM categories')]
        series=[]
        for sid,raw in self.db.execute('SELECT id,body FROM series'):
            item=json.loads(raw);item.pop('imgUrl',None);item['folder']=str(self.series_dir(sid));series.append(item)
        episodes=[]
        orders={eid:p for eid,p in self.db.execute('SELECT episode_id,position FROM episode_order')}
        for eid,sid,raw,detail in self.db.execute('SELECT id,series_id,body,detail FROM episodes'):
            source=json.loads(raw)
            item={k:source.get(k) for k in ('id','videoId','name','nameNew','duration','analysisType')}
            folder=self.episode_dir(eid);item.update(order=orders.get(eid),folder=str(folder) if folder else None,details_fetched=bool(detail),files={})
            for rid,field,state,local,byte_count,digest in self.db.execute('''
                 SELECT r.id,l.field,r.state,r.local_path,r.bytes,r.sha256 FROM resource_links l
                 JOIN resources r ON r.id=l.resource_id WHERE l.entity_type='episode' AND l.entity_id=?''',(eid,)):
                if local and folder:
                    names={'videoUrl':'视频','srtEnUrl':'英文字幕','srtCnEnUrl':'中英字幕'}
                    path=folder/(names.get(field,field)+Path(local).suffix)
                    item['files'][field]={'path':str(path),'status':state,'bytes':byte_count,'sha256':digest}
                else:item['files'][field]={'status':state}
            episodes.append(item)
        out={'schema_version':1,'categories':categories,'series':series,'episodes':episodes,
             'all_resources_downloaded':not self.db.execute("SELECT 1 FROM jobs WHERE state!='done' LIMIT 1").fetchone()
                and not self.db.execute("SELECT 1 FROM resources WHERE state!='done' LIMIT 1").fetchone()}
        target=self.root/'catalog.json';temp=target.with_suffix('.json.tmp');temp.write_text(json.dumps(out,ensure_ascii=False,indent=2));temp.replace(target)
