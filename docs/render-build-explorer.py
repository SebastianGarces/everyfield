#!/usr/bin/env python3
"""Render the local explorer design while preserving its embedded source snapshot."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile

IDS=('canonical-data','canonical-progress','embedded-local-state')
TOKENS=('__CANONICAL_DATA__','__CANONICAL_PROGRESS__','__EMBEDDED_LOCAL_STATE__')

def payloads(html):
    found={}
    for name in IDS:
        matches=list(re.finditer(r'<script\s+type="application/json"\s+id="'+name+r'">([\s\S]*?)</script>',html))
        if len(matches)!=1:raise ValueError('Expected one '+name+' JSON script')
        found[name]=json.loads(matches[0][1])
    return found

def encoded(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')

def frame(html):
    for name in IDS:
        html=re.sub(r'(<script\s+type="application/json"\s+id="'+name+r'">)[\s\S]*?(</script>)',r'\1JSON\2',html)
    return html

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',default=str(Path(__file__).resolve().parent.parent))
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check',action='store_true')
    mode.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    root=Path(args.root).resolve(strict=True)
    def inside(relative):
        p=root/relative
        if not p.resolve().is_relative_to(root)or p.is_symlink():raise ValueError('Unsafe path: '+relative)
        cursor=p
        while cursor!=root:
            if cursor.is_symlink():raise ValueError('Unsafe symlink: '+relative)
            cursor=cursor.parent
        return p
    lock=inside('docs/.build-progress.lock').open('a+')
    try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise ValueError('Explorer/progress integration is already running; retry after its owner finishes')
    html_path=inside('everyfield-build-explorer.html')
    template_path=inside('docs/explorer-ui.template.html')
    progress_path=inside('docs/build-progress.json')
    original=html_path.read_text()
    data=payloads(original)
    canonical=json.loads(progress_path.read_text())
    template=template_path.read_text()
    for token in TOKENS:
        if template.count(token)!=1:raise ValueError('Expected one '+token+' template token')
    values=(data['canonical-data'],canonical,data['embedded-local-state'])
    rendered=template
    # Preserve an explicit theme in a portable file; old files default to template dark.
    saved_theme=re.search(r'<html\b[^>]*\bdata-theme="(dark|light)"',original)
    if saved_theme and 'data-theme="dark"' in rendered:
        rendered=rendered.replace('data-theme="dark"','data-theme="'+saved_theme[1]+'"',1)
    for token,value in zip(TOKENS,values):rendered=rendered.replace(token,encoded(value))
    result=payloads(rendered)
    if result['canonical-data']!=data['canonical-data']or result['embedded-local-state']!=data['embedded-local-state']:
        raise ValueError('Rendering would discard source snapshot or embedded local changes')
    if args.check:
        if frame(original)!=frame(rendered)or data['canonical-progress']!=canonical:
            raise ValueError('Explorer differs from design template or canonical progress; use --apply, then the progress updater --check')
        print('Valid: current design template; source snapshot/local state preserved; canonical progress matches.')
        return
    if rendered==original:
        print('Explorer already matches the current template and canonical progress.')
        return
    with tempfile.NamedTemporaryFile(mode='w',prefix='.explorer-ui-',dir=root,delete=False)as handle:
        temp=Path(handle.name);handle.write(rendered);handle.flush();os.fsync(handle.fileno())
    try:
        os.chmod(temp,html_path.stat().st_mode&0o777)
        os.replace(temp,html_path)
    finally:temp.unlink(missing_ok=True)
    print('Rendered explorer design; embedded source snapshot and local changes preserved; canonical progress retained.')

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError)as error:raise SystemExit('ERROR: '+str(error))
