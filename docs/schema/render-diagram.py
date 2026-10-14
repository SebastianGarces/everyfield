#!/usr/bin/env python3
"""Render schema-diagram.html, an offline interactive ER diagram of the adopted schema.

The output embeds target.json, the capability files and the check.py counts. The layout
is computed in the page from the data alone, so a changed schema needs only a new run.
The same inputs always produce the same bytes.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402  Reuse the exact count and validation rules.


def count_row(tables):
    keys = ('tables', 'columns', 'fks', 'jsonb')
    return dict(zip(keys, check.counts(tables)))


def build_data(root):
    schema_path = root / 'docs/schema/target.json'
    raw = schema_path.read_bytes()
    schema = json.loads(raw)
    cap_paths = sorted((root / 'docs/schema/capabilities').glob('*.json'))
    cap_files = [check.read(path) for path in cap_paths]
    features = check.read(root / 'docs/catalog/features.json')
    readme = (root / 'docs/schema/README.md').read_text()
    exceptions = set(check.re.findall(r'^- `([^`]+ -> [^`]+)`: .+', readme, check.re.M))
    errors = check.validate_schema(schema, 'authority', True, exceptions)
    errors += check.validate_catalog_sets(schema, check.read(root / 'docs/catalog/operations.json')['operations'])
    errors += check.validate_metadata(schema, check.read(root / 'docs/plan/dag.json'), cap_files)
    coverage_errors, coverage_lines = check.coverage(cap_files, features, schema)
    errors += coverage_errors
    domains = {d['id']: count_row([t for t in schema['tables'] if t['domain'] == d['id']])
               for d in schema['domains']}

    capabilities = {}
    for file in cap_files:
        for cap in file['capabilities']:
            capabilities[cap['id']] = {
                'name': cap['name'], 'group': file['group'], 'persists': cap['persists'],
                'history': cap.get('history', ''), 'facts': cap.get('facts', []),
                'features': cap.get('feature_ids', []),
            }

    return {
        'schema': schema,
        'capabilities': capabilities,
        'counts': {**count_row(schema['tables']), 'domains': domains},
        'coverage': [line for line in coverage_lines if line.split(':')[0] in
                     ('Active features covered', 'Persistent capabilities mapped')],
        'errors': errors,
        'source': {'file': 'docs/schema/target.json', 'sha256': hashlib.sha256(raw).hexdigest()},
    }


def encoded(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return text.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=Path, default=HERE.parent.parent, help='repository root')
    parser.add_argument('--out', type=Path, help='output file; defaults to schema-diagram.html beside target.json')
    parser.add_argument('--check', action='store_true', help='fail if the output differs from a fresh render; do not write')
    args = parser.parse_args()
    data = build_data(args.root)
    if TEMPLATE.count('__DATA__') != 1:
        raise ValueError('template must contain one __DATA__ token')
    if data['errors']:
        raise ValueError('Authority validation failed: ' + '; '.join(data['errors']))
    html = TEMPLATE.replace('__DATA__', encoded(data))
    out = args.out or args.root / 'docs/schema/schema-diagram.html'
    if args.check:
        if not out.exists() or out.read_bytes() != html.encode('utf-8'):
            print(f'Stale schema diagram: {out}. Run python3 docs/schema/render-diagram.py.', file=sys.stderr)
            return 1
        print(f'Schema diagram matches current inputs: {out}')
        return 0
    out.write_bytes(html.encode('utf-8'))
    print(f'Wrote {out} ({len(data["schema"]["tables"])} tables, {len(data["errors"])} check problems)')
    return 0


TEMPLATE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Adopted schema: entity-relationship diagram</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #E9ECF0; --surface: #FAFBFC; --raised: #FFFFFF; --sunken: #EDF0F4;
  --text: #181D19; --text-2: #4D5361; --text-3: #626874;
  --line: rgba(22, 30, 46, .14); --line-soft: rgba(22, 30, 46, .075); --hover: rgba(22, 30, 46, .055);
  --focus: #1C5BB5; --sel: #0F7E3C; --out: #1C5BB5; --in: #B02A4A;
  --match: #C2690A; --match-bg: #FFE7CC; --edge: rgba(22, 30, 46, .22);
  --shadow: 0 1px 2px rgba(22, 30, 46, .06), 0 2px 8px rgba(22, 30, 46, .05);
  --shadow-float: 0 1px 2px rgba(22, 30, 46, .08), 0 8px 24px rgba(22, 30, 46, .12);
  --head-l: .952; --head-c: .032; --stripe-l: .6; --stripe-c: .13; --region-l: .972; --region-c: .016;
  --font: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0F1211; --surface: #161A19; --raised: #1D2224; --sunken: #121615;
    --text: #EEF1F4; --text-2: #BAC0C9; --text-3: #9AA1AD;
    --line: rgba(230, 236, 245, .15); --line-soft: rgba(230, 236, 245, .08); --hover: rgba(230, 236, 245, .07);
    --focus: #6AAEFF; --sel: #1CE362; --out: #6AAEFF; --in: #F2728A;
    --match: #FFA552; --match-bg: rgba(255, 165, 82, .22); --edge: rgba(230, 236, 245, .17);
    --shadow: 0 1px 2px rgba(0, 0, 0, .4); --shadow-float: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .45);
    --head-l: .3; --head-c: .045; --stripe-l: .74; --stripe-c: .12; --region-l: .2; --region-c: .022;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; font: 14px/1.45 var(--font); color: var(--text); background: var(--surface);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: 296px minmax(0, 1fr) auto;
  grid-template-areas: "head head head" "side main panel"; overflow: hidden;
}
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
code, .mono { font-family: var(--mono); font-size: .92em; }

/* Header */
header.top {
  grid-area: head; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 32px;
  padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--surface);
}
.title h1 { margin: 0; font-size: 18px; line-height: 1.2; font-weight: 650; letter-spacing: -.01em; }
.title p { margin: 2px 0 0; font-size: 13px; color: var(--text-2); }
.stats { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0; }
.stat dt { font-size: 12px; color: var(--text-2); }
.stat dd { margin: 0; display: flex; align-items: baseline; gap: 6px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stat .now { font-size: 20px; font-weight: 650; line-height: 1.2; letter-spacing: -.01em; }
.stat .was, .stat .delta { font-size: 13px; color: var(--text-2); }
.stat .delta { padding: 0 6px; border-radius: 999px; background: var(--sunken); color: var(--text); }
.coverage { margin-inline-start: auto; font-size: 13px; color: var(--text-2); display: grid; gap: 2px; }
.coverage strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.check-ok::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--sel); margin-inline-end: 6px; }
.problems { grid-column: 1 / -1; width: 100%; font-size: 13px; border: 1px solid var(--in); border-radius: var(--r-md); padding: 8px 12px; }
.problems summary { font-weight: 600; color: var(--in); }
.problems ul { margin: 8px 0 0; padding-inline-start: 20px; max-height: 160px; overflow: auto; }

/* Sidebar */
aside.side {
  grid-area: side; overflow: auto; border-inline-end: 1px solid var(--line); background: var(--surface);
  padding: 16px; display: flex; flex-direction: column; gap: 24px; overscroll-behavior: contain;
}
.side h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; }
.search label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.search-box { position: relative; }
.search input {
  width: 100%; height: 36px; padding: 0 64px 0 12px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--raised); font-size: 14px;
}
.search input::-webkit-search-cancel-button { appearance: none; }
.search input::placeholder { color: var(--text-3); }
.search input:focus-visible { outline-offset: 0; border-color: var(--focus); }
.search kbd { position: absolute; inset-inline-end: 8px; top: 8px; font: 12px var(--mono); color: var(--text-3); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; pointer-events: none; }
.search .clear { position: absolute; inset-inline-end: 4px; top: 4px; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: none; color: var(--text-2); font-size: 13px; }
.search .clear:hover { background: var(--hover); color: var(--text); }
.search .hint { margin: 6px 0 0; font-size: 12px; color: var(--text-2); }
#search-status { margin: 8px 0 0; font-size: 13px; color: var(--text-2); }
.results { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
.results button {
  width: 100%; text-align: start; border: 0; background: none; border-radius: var(--r-sm); padding: 6px 8px;
  display: grid; gap: 1px;
}
.results button:hover { background: var(--hover); }
.results button[aria-current="true"] { background: var(--sunken); box-shadow: inset 3px 0 0 var(--sel); }
.results .r-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.results .r-meta { font-size: 12px; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
.results .r-cols { font-size: 12px; color: var(--text-2); font-family: var(--mono); overflow-wrap: anywhere; }
mark { background: var(--match-bg); color: inherit; border-radius: 2px; box-shadow: 0 0 0 1px var(--match-bg); }

.domains fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.domains legend { padding: 0; width: 100%; display: flex; align-items: center; justify-content: space-between; }
.domains .bulk { display: flex; gap: 4px; }
.small-btn {
  height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--raised);
  font-size: 12px; color: var(--text);
}
.small-btn:hover { background: var(--sunken); }
.dom-list { list-style: none; margin: 4px 0 0; padding: 0; }
.dom-row { display: flex; align-items: center; gap: 4px; border-radius: var(--r-sm); }
.dom-row:hover { background: var(--hover); }
.dom-row label { flex: 1; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 6px; cursor: pointer; font-size: 13px; }
.dom-row input { margin: 0; width: 16px; height: 16px; accent-color: var(--sel); }
.dom-row .counts { margin-inline-start: auto; font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 12px; white-space: nowrap; }
.dom-row .only { opacity: 0; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: none; font-size: 12px; color: var(--text-2); }
.dom-row:hover .only, .dom-row .only:focus-visible { opacity: 1; }
.dom-row .only:hover { background: var(--sunken); color: var(--text); }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; background: oklch(var(--stripe-l) var(--stripe-c) var(--h)); }

.view label { display: flex; align-items: center; gap: 8px; min-height: 32px; font-size: 13px; cursor: pointer; }
.view input { margin: 0; width: 16px; height: 16px; accent-color: var(--sel); }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 12px; color: var(--text-2); }
.legend li { display: flex; align-items: center; gap: 8px; }
.legend svg { flex: none; }
.source { font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; margin: 0; }

/* Canvas */
main { grid-area: main; position: relative; overflow: hidden; background: var(--bg); min-width: 0; }
#viewport { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; }
#viewport.panning { cursor: grabbing; }
#viewport:focus-visible { outline-offset: -3px; }
#world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
svg.edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 1; }
svg.edges.top { z-index: 3; }
svg.edges path { fill: none; stroke: var(--edge); stroke-width: 1; vector-effect: non-scaling-stroke; }
.lines-off svg.edges.base { display: none; }
.has-sel svg.edges.base path { opacity: .25; }
svg.edges.top path { stroke-width: 1.75; opacity: .85; }
svg.edges.top path.out { stroke: var(--out); }
svg.edges.top path.in { stroke: var(--in); stroke-dasharray: 6 4; }
svg.edges.top circle.out { fill: var(--out); }
svg.edges.top circle.in { fill: var(--in); }
.region { position: absolute; }
.region::before {
  content: ""; position: absolute; inset: 0; z-index: 0; border-radius: 20px;
  background: oklch(var(--region-l) var(--region-c) var(--h)); border: 1px solid var(--line-soft);
}
.region h2 {
  position: absolute; left: 20px; top: 18px; z-index: 2; margin: 0; display: flex; align-items: baseline; gap: 10px;
  font-size: 20px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap;
}
.region h2 .swatch { width: 12px; height: 12px; align-self: center; }
.region h2 small { font-size: 13px; font-weight: 500; color: var(--text-2); font-variant-numeric: tabular-nums; }
.card {
  position: absolute; z-index: 2; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md);
  box-shadow: var(--shadow); overflow: hidden; transition: opacity .15s ease;
}
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: oklch(var(--stripe-l) var(--stripe-c) var(--h)); }
.card-head { margin: 0; height: 40px; background: oklch(var(--head-l) var(--head-c) var(--h)); border-bottom: 1px solid var(--line-soft); }
.card-btn {
  width: 100%; height: 100%; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 14px;
  border: 0; background: none; text-align: start; border-radius: 0;
}
.card-btn:hover { background: var(--hover); }
.card-btn:focus-visible { outline-offset: -3px; border-radius: var(--r-md) var(--r-md) 0 0; }
.tname { font-weight: 650; font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex: none; font-size: 11px; font-weight: 600; letter-spacing: .02em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--text-2); background: var(--raised); }
.card-btn .ncols { margin-inline-start: auto; flex: none; font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.cols { list-style: none; margin: 0; padding: 6px 0; }
.col { height: 22px; display: flex; align-items: center; gap: 6px; padding: 0 10px 0 14px; font-size: 12.5px; }
.col .k { flex: none; width: 34px; display: flex; gap: 2px; }
.col .k b { font-size: 10px; font-weight: 700; line-height: 14px; padding: 0 3px; border-radius: 3px; letter-spacing: .02em; }
.col .k .pk { background: var(--text); color: var(--raised); }
.col .k .fk { border: 1px solid var(--text-3); color: var(--text-2); line-height: 12px; }
.col .n { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col.pkc .n { font-weight: 600; }
.col .t { flex: none; font-family: var(--mono); font-size: 11.5px; color: var(--text-2); }
.col .t .q { color: var(--text-3); }
.col.hl-out { background: color-mix(in oklab, var(--out) 14%, transparent); }
.col.hl-in { background: color-mix(in oklab, var(--in) 14%, transparent); }
.more {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: calc(100% - 16px); height: 26px; margin: 0 8px 4px;
  border: 1px dashed var(--line); border-radius: var(--r-sm); background: none; color: var(--text-2); font-size: 12px;
}
.more:hover { background: var(--hover); color: var(--text); border-style: solid; }
.more .mcount { color: var(--match); font-weight: 600; }
.card.sel { box-shadow: 0 0 0 2px var(--sel), var(--shadow-float); border-color: transparent; }
.card.match { box-shadow: 0 0 0 2px var(--match), var(--shadow); border-color: transparent; }
.card.sel.match { box-shadow: 0 0 0 2px var(--sel), 0 0 0 5px var(--match), var(--shadow-float); }
.has-sel .card:not(.sel):not(.rel), .has-query:not(.has-sel) .card:not(.match) { opacity: .28; }
.has-sel .region h2, .has-query .region h2 { opacity: .7; }

/* Far zoom: names only */
.far .cols, .far .more { visibility: hidden; }
.far .card-head { position: absolute; inset: 0; height: auto; border: 0; }
.far .card-btn { align-items: flex-start; padding: 12px 14px 12px 18px; }
.far .tname { white-space: normal; overflow-wrap: break-word; font-size: clamp(14px, calc(11px / var(--k)), 38px); line-height: 1.1; overflow: visible; }
.far .card-btn .ncols, .far .badge { display: none; }
.far .region h2 { font-size: clamp(20px, calc(14px / var(--k)), 64px); top: auto; bottom: calc(100% - 58px); line-height: 1.1; }
.far .region h2 small { font-size: .6em; }

.zoombar {
  position: absolute; inset-inline-start: 16px; bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 2px; padding: 4px;
  background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-float);
}
.zoombar button { min-width: 32px; height: 32px; padding: 0 8px; border: 0; background: none; border-radius: var(--r-md); font-size: 13px; }
.zoombar button:hover { background: var(--hover); }
.zoombar .pct { min-width: 56px; font-variant-numeric: tabular-nums; color: var(--text-2); }
.zoombar .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
.canvas-help { position: absolute; inset-inline-end: 16px; bottom: 16px; z-index: 5; margin: 0; font-size: 12px; color: var(--text-2);
  background: color-mix(in oklab, var(--raised) 85%, transparent); padding: 4px 10px; border-radius: 999px; }
.empty[hidden] { display: none; }
.empty { position: absolute; inset: 0; display: grid; place-items: center; z-index: 4; pointer-events: none; }
.empty p { margin: 0; padding: 12px 16px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md); color: var(--text-2); font-size: 14px; }

/* Detail panel */
#panel {
  grid-area: panel; width: 440px; overflow: auto; border-inline-start: 1px solid var(--line); background: var(--surface);
  overscroll-behavior: contain;
}
#panel[hidden] { display: none; }
.p-head { position: sticky; top: 0; z-index: 1; background: var(--surface); padding: 16px 20px 12px; border-bottom: 1px solid var(--line-soft); }
.p-top { display: flex; align-items: center; gap: 8px; }
.p-dom { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.p-close { margin-inline-start: auto; width: 32px; height: 32px; border: 0; border-radius: var(--r-md); background: none; display: grid; place-items: center; color: var(--text-2); }
.p-close:hover { background: var(--hover); color: var(--text); }
#p-title { margin: 6px 0 0; font-size: 20px; line-height: 1.25; font-weight: 650; letter-spacing: -.01em; overflow-wrap: anywhere; }
#p-title:focus-visible { outline-offset: 4px; border-radius: 4px; }
.p-meta { margin: 4px 0 0; font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.p-body { padding: 16px 20px 32px; display: grid; gap: 24px; }
.p-body section h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; display: flex; align-items: center; gap: 8px; }
.p-body section h3 .dot { width: 10px; height: 3px; border-radius: 2px; }
.p-body p { margin: 0; text-wrap: pretty; }
.purpose { font-size: 14px; }
.replaces { margin-top: 8px !important; font-size: 13px; color: var(--text-2); }
table.cols-t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cols-t th { text-align: start; font-weight: 600; font-size: 12px; color: var(--text-2); padding: 4px 6px; border-bottom: 1px solid var(--line); position: sticky; top: 0; }
.cols-t td { padding: 5px 6px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.cols-t td:first-child { overflow-wrap: anywhere; }
.cols-t .t { font-family: var(--mono); font-size: 11.5px; color: var(--text-2); white-space: nowrap; }
.cols-t .note { display: block; color: var(--text-2); font-size: 12px; margin-top: 2px; }
.cols-t .k b { font-size: 10px; font-weight: 700; padding: 0 3px; border-radius: 3px; margin-inline-end: 4px; }
.cols-t .k .pk { background: var(--text); color: var(--raised); }
.cols-t .k .fk { border: 1px solid var(--text-3); color: var(--text-2); }
.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.plain .muted { color: var(--text-2); }
.rel-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.rel-list button {
  width: 100%; text-align: start; border: 0; background: none; padding: 6px 8px; border-radius: var(--r-sm);
  display: grid; gap: 1px; font-size: 13px;
}
.rel-list button:hover { background: var(--hover); }
.rel-list .rt { font-weight: 600; display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.rel-list .rc { font-family: var(--mono); font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }
.checks { margin: 0; padding-inline-start: 18px; display: grid; gap: 6px; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
dl.jsonb { margin: 0; display: grid; gap: 4px; font-size: 13px; }
dl.jsonb dt { font-family: var(--mono); font-size: 12px; font-weight: 600; margin-top: 6px; }
dl.jsonb dd { margin: 0; color: var(--text-2); }
dl.jsonb dd code { color: var(--text); }
details.cap { border: 1px solid var(--line-soft); border-radius: var(--r-md); background: var(--raised); }
details.cap + details.cap { margin-top: 6px; }
details.cap summary { cursor: pointer; padding: 8px 10px; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
details.cap summary::marker { color: var(--text-3); }
details.cap summary code { flex: none; color: var(--text-2); font-size: 12px; }
details.cap .cap-body { padding: 0 12px 10px 28px; font-size: 13px; color: var(--text-2); }
details.cap ul { margin: 4px 0 0; padding-inline-start: 18px; display: grid; gap: 4px; }

@media (prefers-reduced-motion: reduce) { .card { transition: none; } }
@media (max-width: 960px) {
  body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); grid-template-areas: "head" "side" "main"; }
  aside.side { max-height: 34vh; border-inline-end: 0; border-bottom: 1px solid var(--line); }
  #panel { position: fixed; inset: auto 0 0 0; width: auto; max-height: 70vh; z-index: 10; border-top: 1px solid var(--line); box-shadow: var(--shadow-float); }
  .coverage { margin-inline-start: 0; }
  .canvas-help { display: none; }
}
@media (forced-colors: active) {
  .card, .region::before { border: 1px solid CanvasText; }
  .card.sel { outline: 3px solid Highlight; }
  .card.match { outline: 2px dashed Highlight; }
}
</style>
</head>
<body>
<header class="top">
  <div class="title">
    <h1>Adopted schema</h1>
    <p id="subtitle"></p>
  </div>
  <dl class="stats" id="stats" aria-label="Adopted schema counts"></dl>
  <div class="coverage" id="coverage"></div>
</header>

<aside class="side" aria-label="Search, filters and legend">
  <section class="search" role="search">
    <label for="q">Search tables and columns</label>
    <div class="search-box">
      <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. person or plant_id" aria-describedby="q-hint" aria-controls="results">
      <kbd id="q-kbd" aria-hidden="true">/</kbd>
      <button type="button" class="clear" id="q-clear" hidden>Clear</button>
    </div>
    <p class="hint" id="q-hint">Press Enter to open the first match. Arrow keys move through the results.</p>
    <p id="search-status" role="status" aria-live="polite"></p>
    <ul class="results" id="results" aria-label="Search results"></ul>
  </section>

  <section class="domains">
    <fieldset>
      <legend><h2>Domains</h2><span class="bulk"><button type="button" class="small-btn" id="dom-all">Show all</button><button type="button" class="small-btn" id="dom-none">Hide all</button></span></legend>
      <ul class="dom-list" id="dom-list"></ul>
    </fieldset>
  </section>

  <section class="view">
    <h2>View</h2>
    <label><input type="checkbox" id="lines" checked> Show all relation lines</label>
  </section>

  <section>
    <h2>Legend</h2>
    <ul class="legend">
      <li><span class="col" style="padding:0;height:auto"><span class="k"><b class="pk" style="font-size:10px;padding:0 3px;border-radius:3px;background:var(--text);color:var(--raised)">PK</b></span></span>Primary key column</li>
      <li><span class="col" style="padding:0;height:auto"><span class="k"><b class="fk" style="font-size:10px;padding:0 3px;border-radius:3px;border:1px solid var(--text-3);color:var(--text-2)">FK</b></span></span>Foreign key column</li>
      <li><span class="mono" style="width:34px;color:var(--text-3);text-align:center">text?</span>Nullable column</li>
      <li><svg width="34" height="8" aria-hidden="true"><line x1="0" y1="4" x2="34" y2="4" stroke="var(--out)" stroke-width="2"/></svg>References (from the selected table)</li>
      <li><svg width="34" height="8" aria-hidden="true"><line x1="0" y1="4" x2="34" y2="4" stroke="var(--in)" stroke-width="2" stroke-dasharray="6 4"/></svg>Referenced by (into the selected table)</li>
    </ul>
  </section>
  <p class="source" id="source"></p>
</aside>

<main>
  <div id="viewport" tabindex="0" role="group" aria-roledescription="diagram" aria-label="Schema diagram. Arrow keys pan, plus and minus zoom, 0 fits all tables." >
    <div id="world">
      <svg class="edges base" id="edges" aria-hidden="true"></svg>
      <div id="regions"></div>
      <svg class="edges top" id="edges-top" aria-hidden="true"></svg>
    </div>
  </div>
  <div class="empty" id="empty" hidden><p>All domains are hidden. Turn on a domain to see its tables.</p></div>
  <div class="zoombar" role="toolbar" aria-label="Zoom">
    <button type="button" id="z-out" aria-label="Zoom out">&minus;</button>
    <button type="button" id="z-reset" class="pct" aria-label="Zoom to 100 percent">100%</button>
    <button type="button" id="z-in" aria-label="Zoom in">+</button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" id="z-fit">Fit to screen</button>
  </div>
  <p class="canvas-help" aria-hidden="true">Drag or scroll to pan · Ctrl/⌘ + scroll to zoom</p>
</main>

<aside id="panel" aria-labelledby="p-title" hidden></aside>

<script type="application/json" id="data">__DATA__</script>
<script>
"use strict";
(() => {
const DATA = JSON.parse(document.getElementById("data").textContent);
const SCHEMA = DATA.schema;
const CAPS = DATA.capabilities;
const CW = 300, HEAD = 40, ROW = 22, PADV = 6, FOOT = 30, GAP = 20, RPAD = 20, RHEAD = 64, RGAP = 72;
const MAX_FULL = 16, SHOWN = 12, FAR = 0.45, MINK = 0.04, MAXK = 2.5;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en-US");
const fmt = (n) => nf.format(n);
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + nf.format(Math.abs(n));
const wbr = (s) => esc(s).replace(/_/g, "_<wbr>");

/* ---------- Model ---------- */
const domains = SCHEMA.domains.map((d, i) => ({ ...d, hue: Math.round((32 + i * 137.508) % 360), tables: [] }));
const domainById = new Map(domains.map((d) => [d.id, d]));
const tables = SCHEMA.tables.map((t, i) => ({ ...t, index: i, colIndex: new Map(t.columns.map((c, j) => [c.name, j])), out: [], in: [] }));
const byName = new Map(tables.map((t) => [t.name, t]));
for (const t of tables) {
  let d = domainById.get(t.domain);
  if (!d) { d = { id: t.domain, name: t.domain, hue: 0, tables: [] }; domains.push(d); domainById.set(d.id, d); }
  t.dom = d; d.tables.push(t);
  t.pkSet = new Set(t.primary_key);
  t.fkSet = new Set(t.foreign_keys.flatMap((f) => f.columns));
  t.collapsible = t.columns.length > MAX_FULL;
}
/* An edge anchors on the first column pair whose names differ, so (person_id, plant_id) draws from person_id. */
const edges = [];
for (const t of tables) {
  t.foreign_keys.forEach((fk, fi) => {
    const target = byName.get(fk.references.table);
    if (!target) return;
    const pairs = fk.columns.map((c, j) => [c, fk.references.columns[j]]);
    const pair = pairs.find(([a, b]) => a !== b) || pairs[0];
    if (!t.colIndex.has(pair[0]) || !target.colIndex.has(pair[1])) return;
    const e = { id: edges.length, from: t, to: target, fromCol: pair[0], toCol: pair[1], fk, fi };
    edges.push(e); t.out.push(e); target.in.push(e);
  });
}
for (const d of domains) {
  d.tables.sort((a, b) => b.in.length - a.in.length || a.index - b.index);
  const n = d.tables.length;
  d.ncols = n <= 3 ? n : n <= 6 ? 3 : 4;
  const heights = new Array(d.ncols).fill(0);
  d.columns = Array.from({ length: d.ncols }, () => []);
  for (const t of d.tables) {
    let c = 0;
    for (let i = 1; i < d.ncols; i++) if (heights[i] < heights[c] - 1) c = i;
    d.columns[c].push(t);
    heights[c] += collapsedHeight(t) + GAP;
  }
  d.w = d.ncols * CW + (d.ncols - 1) * GAP + 2 * RPAD;
  d.baseH = RHEAD + Math.max(...heights) - GAP + RPAD;
}
function collapsedHeight(t) { return HEAD + 2 * PADV + Math.min(t.columns.length, t.collapsible ? SHOWN : Infinity) * ROW + (t.collapsible ? FOOT : 0); }

/* ---------- State ---------- */
const state = { k: 1, x: 0, y: 0, sel: null, hover: null, query: "", hidden: new Set(), expanded: new Set(), lines: true, packW: null };
const world = $("world"), viewport = $("viewport"), regionsEl = $("regions"), edgesEl = $("edges"), topEl = $("edges-top");

/* ---------- Header ---------- */
(function renderHeader() {
  const c = DATA.counts;
  $("subtitle").textContent = `${SCHEMA.database} · ${domains.length} domains · reviewed starting design`;
  const rows = [["Tables", "tables"], ["Columns", "columns"], ["Foreign keys", "fks"], ["JSONB columns", "jsonb"]];
  $("stats").innerHTML = rows.map(([label, key]) => {
    return `<div class="stat"><dt>${label}</dt><dd><span class="now">${fmt(c[key])}</span></dd></div>`;
  }).join("");
  const cov = DATA.coverage.map((line) => { const [k, v] = line.split(": "); return `<span>${esc(k)}: <strong>${esc(v)}</strong></span>`; }).join("");
  const errs = DATA.errors;
  const status = errs.length ? "" : `<span class="check-ok">check.py passes</span>`;
  $("coverage").innerHTML = cov + status;
  if (errs.length) {
    const box = document.createElement("details");
    box.className = "problems";
    box.innerHTML = `<summary>check.py reports ${errs.length} problem${errs.length === 1 ? "" : "s"}</summary><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    document.querySelector("header.top").append(box);
  }
  $("source").innerHTML = `Generated from <code>${esc(DATA.source.file)}</code><br>SHA-256 <code title="${esc(DATA.source.sha256)}">${esc(DATA.source.sha256.slice(0, 12))}</code> by render-diagram.py`;
})();

/* ---------- Domain filters ---------- */
(function renderDomainFilters() {
  const dc = DATA.counts.domains;
  $("dom-list").innerHTML = domains.map((d) => {
    const now = dc[d.id].tables;
    return `<li class="dom-row" style="--h:${d.hue}"><label><input type="checkbox" data-dom="${esc(d.id)}" checked><span class="swatch" aria-hidden="true"></span>${esc(d.name)}<span class="counts" aria-label="${now} tables">${now}</span></label><button type="button" class="only" data-only="${esc(d.id)}" aria-label="Show only ${esc(d.name)}">Only</button></li>`;
  }).join("");
  $("dom-list").addEventListener("change", (e) => {
    const id = e.target.dataset.dom;
    if (!id) return;
    if (e.target.checked) state.hidden.delete(id); else state.hidden.add(id);
    afterFilter();
  });
  $("dom-list").addEventListener("click", (e) => {
    const id = e.target.closest("[data-only]")?.dataset.only;
    if (!id) return;
    state.hidden = new Set(domains.map((d) => d.id).filter((x) => x !== id));
    syncFilterInputs(); afterFilter();
  });
  $("dom-all").addEventListener("click", () => { state.hidden.clear(); syncFilterInputs(); afterFilter(); });
  $("dom-none").addEventListener("click", () => { state.hidden = new Set(domains.map((d) => d.id)); syncFilterInputs(); afterFilter(); });
})();
function syncFilterInputs() { for (const input of document.querySelectorAll("[data-dom]")) input.checked = !state.hidden.has(input.dataset.dom); }
function afterFilter() {
  if (state.sel && state.hidden.has(state.sel.dom.id)) closePanel(false);
  state.packW = null; layout(); fit(); renderSearch();
}

/* ---------- Cards ---------- */
function visibleCols(t) { return t.collapsible && !state.expanded.has(t.name) ? SHOWN : t.columns.length; }
function cardHeight(t) { return HEAD + 2 * PADV + visibleCols(t) * ROW + (t.collapsible ? FOOT : 0); }
function colRow(t, c) {
  const k = (t.pkSet.has(c.name) ? `<b class="pk" title="Primary key">PK</b>` : "") + (t.fkSet.has(c.name) ? `<b class="fk" title="Foreign key">FK</b>` : "");
  const name = state.query ? highlight(c.name, state.query) : esc(c.name);
  const nullable = c.nullable ? `<span class="q" title="nullable">?</span>` : "";
  return `<li class="col${t.pkSet.has(c.name) ? " pkc" : ""}" data-col="${esc(c.name)}" title="${esc(c.name)}: ${esc(c.type)}${c.nullable ? ", nullable" : ", not null"}"><span class="k">${k}</span><span class="n">${name}</span><span class="t">${esc(c.type)}${nullable}</span><span class="visually-hidden">${c.nullable ? "nullable" : "not null"}</span></li>`;
}
function renderCols(t) {
  const n = visibleCols(t);
  t.colsEl.innerHTML = t.columns.slice(0, n).map((c) => colRow(t, c)).join("");
  if (t.moreEl) {
    const hidden = t.columns.length - n;
    const hiddenMatches = state.query ? t.columns.slice(n).filter((c) => c.name.toLowerCase().includes(state.query)).length : 0;
    t.moreEl.setAttribute("aria-expanded", String(hidden === 0));
    t.moreEl.innerHTML = hidden ? `Show all ${t.columns.length} columns${hiddenMatches ? ` <span class="mcount">· ${hiddenMatches} match${hiddenMatches === 1 ? "" : "es"}</span>` : ""}` : "Show fewer columns";
  }
}
function buildCanvas() {
  for (const d of domains) {
    const region = document.createElement("section");
    region.className = "region"; region.style.setProperty("--h", d.hue);
    region.setAttribute("aria-labelledby", `dom-${d.id}`);
    region.innerHTML = `<h2 id="dom-${esc(d.id)}"><span class="swatch" aria-hidden="true"></span>${esc(d.name)}<small>${d.tables.length} table${d.tables.length === 1 ? "" : "s"}</small></h2>`;
    for (const t of d.tables) {
      const card = document.createElement("article");
      card.className = "card"; card.style.width = CW + "px";
      card.dataset.t = t.name;
      card.innerHTML = `<h3 class="card-head"><button type="button" class="card-btn" aria-pressed="false" aria-controls="panel" aria-label="${esc(t.name)}, ${t.columns.length} columns${t.library_owned ? ", auth library table" : ""}"><span class="tname" aria-hidden="true">${wbr(t.name)}</span>${t.library_owned ? `<span class="badge" title="Owned by the auth library">library</span>` : ""}<span class="ncols" aria-hidden="true">${t.columns.length}</span></button></h3><ul class="cols" aria-label="Columns of ${esc(t.name)}"></ul>${t.collapsible ? `<button type="button" class="more" aria-expanded="false"></button>` : ""}`;
      t.card = card; t.btn = card.querySelector(".card-btn"); t.colsEl = card.querySelector(".cols"); t.moreEl = card.querySelector(".more");
      renderCols(t);
      region.append(card);
    }
    d.el = region;
    regionsEl.append(region);
  }
  const frag = document.createDocumentFragment();
  for (const e of edges) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    e.el = p; frag.append(p);
  }
  edgesEl.append(frag);
}

/* ---------- Layout: masonry inside a domain, shelf packing across domains ---------- */
function layout() {
  const shown = domains.filter((d) => !state.hidden.has(d.id) && d.tables.length);
  for (const d of domains) d.el.hidden = !shown.includes(d);
  $("empty").hidden = shown.length > 0;
  for (const d of shown) {
    let h = 0;
    d.columns.forEach((col, ci) => {
      let y = RHEAD;
      for (const t of col) {
        t.x = RPAD + ci * (CW + GAP); t.y = y; t.h = cardHeight(t);
        t.card.style.left = t.x + "px"; t.card.style.top = t.y + "px"; t.card.style.height = t.h + "px";
        y += t.h + GAP;
      }
      h = Math.max(h, y - GAP);
    });
    d.h = h + RPAD;
  }
  const target = state.packW ??= packWidth(shown);
  let x = 0, y = 0, rowH = 0, maxW = 0;
  for (const d of shown) {
    if (x > 0 && x + d.w > target) { x = 0; y += rowH + RGAP; rowH = 0; }
    d.x = x; d.y = y;
    d.el.style.left = x + "px"; d.el.style.top = y + "px"; d.el.style.width = d.w + "px"; d.el.style.height = d.h + "px";
    x += d.w + RGAP; rowH = Math.max(rowH, d.h); maxW = Math.max(maxW, x - RGAP);
  }
  state.bounds = { w: maxW, h: y + rowH };
  world.style.width = maxW + "px"; world.style.height = state.bounds.h + "px";
  for (const svg of [edgesEl, topEl]) { svg.setAttribute("width", maxW); svg.setAttribute("height", state.bounds.h); }
  for (const e of edges) {
    const on = state.lines && isShown(e.from) && isShown(e.to);
    e.el.style.display = on ? "" : "none";
    if (on) e.el.setAttribute("d", edgePath(e));
  }
  drawTop();
}
/* Pick the shelf width whose collapsed bounding box fits the viewport at the largest scale. */
function packWidth(shown) {
  const vw = Math.max(1, viewport.clientWidth - 48), vh = Math.max(1, viewport.clientHeight - 96);
  let best = 0, bestK = -1;
  for (let i = 0; i < shown.length; i++) {
    const limit = shown.slice(0, i + 1).reduce((s, d) => s + d.w, 0) + i * RGAP;
    let x = 0, y = 0, rowH = 0, w = 0;
    for (const d of shown) {
      if (x > 0 && x + d.w > limit) { x = 0; y += rowH + RGAP; rowH = 0; }
      x += d.w + RGAP; rowH = Math.max(rowH, d.baseH); w = Math.max(w, x - RGAP);
    }
    const k = Math.min(vw / w, vh / (y + rowH));
    if (k > bestK + 1e-9) { bestK = k; best = limit; }
  }
  return best;
}
function isShown(t) { return !state.hidden.has(t.dom.id); }
function anchor(t, col) {
  const i = t.colIndex.get(col);
  const left = t.dom.x + t.x, top = t.dom.y + t.y;
  const y = i < visibleCols(t) ? top + HEAD + PADV + i * ROW + ROW / 2 : top + t.h - FOOT / 2 - 2;
  return { l: left, r: left + CW, y };
}
function edgePath(e) {
  const a = anchor(e.from, e.fromCol), b = anchor(e.to, e.toCol);
  if (e.from === e.to) {
    const off = 36, y2 = Math.abs(b.y - a.y) < 4 ? a.y + 12 : b.y;
    return `M${a.r} ${a.y}C${a.r + off} ${a.y} ${a.r + off} ${y2} ${a.r} ${y2}`;
  }
  let sx, sd, tx, td;
  if (b.l > a.r + 24) { sx = a.r; sd = 1; tx = b.l; td = -1; }
  else if (b.r < a.l - 24) { sx = a.l; sd = -1; tx = b.r; td = 1; }
  else { sx = a.r; sd = 1; tx = b.r; td = 1; }
  const c = sd === td ? 48 + Math.min(Math.abs(b.y - a.y) * 0.12, 120) : Math.max(48, Math.min(Math.abs(tx - sx) * 0.5, 280));
  return `M${sx} ${a.y}C${sx + sd * c} ${a.y} ${tx + td * c} ${b.y} ${tx} ${b.y}`;
}

/* ---------- Highlight layer ---------- */
function drawTop() {
  const t = state.sel || state.hover;
  for (const el of document.querySelectorAll(".col.hl-out, .col.hl-in")) el.classList.remove("hl-out", "hl-in");
  if (!t) { topEl.innerHTML = ""; return; }
  const parts = [];
  const mark = (table, cols, cls) => { for (const c of cols) table.colsEl.querySelector(`[data-col="${CSS.escape(c)}"]`)?.classList.add(cls); };
  const add = (e, cls) => {
    if (!isShown(e.from) || !isShown(e.to)) return;
    const d = edgePath(e), b = anchor(e.to, e.toCol);
    const tx = e.from === e.to ? b.r : (b.l > anchor(e.from, e.fromCol).r + 24 ? b.l : b.r);
    parts.push(`<path class="${cls}" d="${d}"/><circle class="${cls}" cx="${tx}" cy="${b.y}" r="3.5"/>`);
    mark(e.from, e.fk.columns, cls === "out" ? "hl-out" : "hl-in");
    mark(e.to, e.fk.references.columns, cls === "out" ? "hl-out" : "hl-in");
  };
  t.in.forEach((e) => add(e, "in"));
  t.out.forEach((e) => add(e, "out"));
  topEl.innerHTML = parts.join("");
}

/* ---------- Pan and zoom ---------- */
function apply() {
  world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.k})`;
  world.style.setProperty("--k", state.k);
  world.classList.toggle("far", state.k < FAR);
  $("z-reset").textContent = Math.round(state.k * 100) + "%";
}
function clampK(k) { return Math.min(MAXK, Math.max(MINK, k)); }
function zoomAt(k, px, py) {
  k = clampK(k);
  state.x = px - (px - state.x) * (k / state.k);
  state.y = py - (py - state.y) * (k / state.k);
  state.k = k; apply();
}
function viewSize() { return { w: viewport.clientWidth, h: viewport.clientHeight }; }
function fit() {
  const { w, h } = viewSize(), b = state.bounds;
  if (!b || !b.w) return;
  const k = clampK(Math.min((w - 48) / b.w, (h - 96) / b.h, 1));
  animateTo(k, (w - b.w * k) / 2, Math.max(24, (h - 72 - b.h * k) / 2));
}
let anim = 0;
function animateTo(k, x, y) {
  cancelAnimationFrame(anim);
  if (reduceMotion) { Object.assign(state, { k, x, y }); apply(); return; }
  const s = { k: state.k, x: state.x, y: state.y }, t0 = performance.now(), dur = 240;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    state.k = s.k + (k - s.k) * e; state.x = s.x + (x - s.x) * e; state.y = s.y + (y - s.y) * e; apply();
    if (p < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}
function reveal(t, minK) {
  const { w, h } = viewSize();
  const k = Math.max(state.k, minK);
  const cx = t.dom.x + t.x + CW / 2, cy = t.dom.y + t.y + Math.min(t.h, h / k - 80) / 2;
  const sx = state.x + (t.dom.x + t.x) * state.k, sy = state.y + (t.dom.y + t.y) * state.k;
  const inside = k === state.k && sx >= 8 && sy >= 8 && sx + CW * k <= w - 8 && sy + Math.min(t.h, 200) * k <= h - 8;
  if (!inside) animateTo(k, w / 2 - cx * k, h / 2 - cy * k);
}
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(state.k * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey ? 4 : 1)), e.clientX - r.left, e.clientY - r.top);
  else { const m = e.deltaMode ? 16 : 1; state.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * m; state.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * m; apply(); }
}, { passive: false });
const pointers = new Map();
let drag = null, dragged = false;
viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, sx: state.x, sy: state.y, id: e.pointerId }; dragged = false; }
  else if (pointers.size === 2) { const [p, q] = [...pointers.values()]; drag = { pinch: Math.hypot(p.x - q.x, p.y - q.y), k: state.k }; dragged = true; }
});
viewport.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  if (drag.pinch) {
    const [p, q] = [...pointers.values()], r = viewport.getBoundingClientRect();
    zoomAt(drag.k * Math.hypot(p.x - q.x, p.y - q.y) / drag.pinch, (p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top);
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  if (!dragged) { dragged = true; viewport.setPointerCapture(drag.id); viewport.classList.add("panning"); }
  state.x = drag.sx + dx; state.y = drag.sy + dy; apply();
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (!pointers.size) { drag = null; viewport.classList.remove("panning"); } };
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);
viewport.addEventListener("click", (e) => {
  if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; return; }
  if (!e.target.closest(".card") && state.sel) closePanel(false);
}, true);
viewport.addEventListener("keydown", (e) => {
  if (e.target !== viewport) return;
  const { w, h } = viewSize(), step = e.shiftKey ? 240 : 80;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key]) { state.x += moves[e.key][0]; state.y += moves[e.key][1]; apply(); e.preventDefault(); }
});
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea");
  if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); $("q").select(); return; }
  if (e.key === "Escape") {
    if (!$("panel").hidden) { e.preventDefault(); closePanel(true); return; }
    if (state.query && e.target !== $("q")) { setQuery(""); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!viewport.contains(e.target) && e.target !== document.body) return;
  const { w, h } = viewSize();
  if (e.key === "+" || e.key === "=") { zoomAt(state.k * 1.25, w / 2, h / 2); e.preventDefault(); }
  else if (e.key === "-" || e.key === "_") { zoomAt(state.k / 1.25, w / 2, h / 2); e.preventDefault(); }
  else if (e.key === "0") { fit(); e.preventDefault(); }
});
$("z-in").addEventListener("click", () => { const { w, h } = viewSize(); zoomAt(state.k * 1.25, w / 2, h / 2); });
$("z-out").addEventListener("click", () => { const { w, h } = viewSize(); zoomAt(state.k / 1.25, w / 2, h / 2); });
$("z-reset").addEventListener("click", () => { const { w, h } = viewSize(); zoomAt(1, w / 2, h / 2); });
$("z-fit").addEventListener("click", fit);
$("lines").addEventListener("change", (e) => { state.lines = e.target.checked; document.body.classList.toggle("lines-off", !state.lines); layout(); });

/* ---------- Card interaction ---------- */
regionsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const t = byName.get(card.dataset.t);
  if (e.target.closest(".more")) {
    if (state.expanded.has(t.name)) state.expanded.delete(t.name); else state.expanded.add(t.name);
    renderCols(t); layout(); return;
  }
  if (e.target.closest(".card-btn")) {
    if (state.sel === t) closePanel(false);
    else select(t, { reveal: false, focusPanel: e.detail === 0, opener: t.btn });
    return;
  }
  if (state.sel !== t) select(t, { reveal: false, focusPanel: false, opener: t.btn });
});
regionsEl.addEventListener("pointerover", (e) => {
  const card = e.target.closest(".card");
  const t = card ? byName.get(card.dataset.t) : null;
  if (t !== state.hover) { state.hover = t; if (!state.sel) drawTop(); }
});
regionsEl.addEventListener("pointerleave", () => { state.hover = null; if (!state.sel) drawTop(); });
regionsEl.addEventListener("focusin", (e) => {
  const card = e.target.closest(".card");
  if (card && e.target.matches(":focus-visible")) reveal(byName.get(card.dataset.t), 0.7);
});

/* ---------- Selection and panel ---------- */
let opener = null;
function setClasses() {
  const t = state.sel;
  world.classList.toggle("has-sel", !!t);
  const related = new Set();
  if (t) { for (const e of t.out) related.add(e.to); for (const e of t.in) related.add(e.from); }
  for (const x of tables) {
    x.card.classList.toggle("sel", x === t);
    x.card.classList.toggle("rel", related.has(x) && x !== t);
    x.btn.setAttribute("aria-pressed", String(x === t));
  }
}
function select(t, { reveal: doReveal = true, focusPanel = false, opener: from = null } = {}) {
  if (state.hidden.has(t.dom.id)) { state.hidden.delete(t.dom.id); syncFilterInputs(); state.packW = null; layout(); }
  state.sel = t; opener = from || document.activeElement;
  setClasses(); drawTop(); renderPanel(t);
  for (const b of document.querySelectorAll("#results button")) b.setAttribute("aria-current", String(b.dataset.t === t.name));
  try { history.replaceState(null, "", "#" + encodeURIComponent(t.name)); } catch (_) {}
  if (doReveal) requestAnimationFrame(() => reveal(t, 0.6));
  if (focusPanel) $("p-title").focus();
}
function closePanel(restoreFocus) {
  const t = state.sel;
  state.sel = null; $("panel").hidden = true;
  setClasses(); drawTop();
  for (const b of document.querySelectorAll("#results button")) b.setAttribute("aria-current", "false");
  try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
  if (restoreFocus) {
    const target = opener && opener.isConnected && !$("panel").contains(opener) ? opener : t && t.btn;
    target?.focus({ preventScroll: true });
  }
}
function keyBadges(t, name) {
  return (t.pkSet.has(name) ? `<b class="pk">PK</b>` : "") + (t.fkSet.has(name) ? `<b class="fk">FK</b>` : "");
}
function tableChip(t) { return `<span class="swatch" style="--h:${t.dom.hue}" aria-hidden="true"></span>${esc(t.name)}`; }
function renderPanel(t) {
  const panel = $("panel");
  const cols = t.columns.map((c) => {
    const notes = [c.meaning, c.note, c.default ? `Default: ${c.default}` : ""].filter(Boolean).map((n) => `<span class="note">${esc(n)}</span>`).join("");
    return `<tr><td><span class="k">${keyBadges(t, c.name)}</span>${esc(c.name)}${notes}</td><td class="t">${esc(c.type)}</td><td>${c.nullable ? "yes" : "no"}</td></tr>`;
  }).join("");
  const uniques = t.unique_keys.map((u) => `<li><code>(${u.columns.map(esc).join(", ")})</code>${u.where ? ` <span class="muted">where <code>${esc(u.where)}</code></span>` : ""}</li>`).join("");
  const outs = t.foreign_keys.map((fk, i) => {
    const target = byName.get(fk.references.table);
    const body = `<span class="rt">${target ? tableChip(target) : esc(fk.references.table) + " (missing)"}</span><span class="rc">(${fk.columns.map(esc).join(", ")}) → (${fk.references.columns.map(esc).join(", ")})${fk.on_delete ? ` · on delete ${esc(fk.on_delete.toLowerCase())}` : ""}</span>`;
    return `<li>${target ? `<button type="button" data-goto="${esc(target.name)}">${body}</button>` : `<div>${body}</div>`}</li>`;
  }).join("");
  const ins = t.in.map((e) => `<li><button type="button" data-goto="${esc(e.from.name)}"><span class="rt">${tableChip(e.from)}</span><span class="rc">(${e.fk.columns.map(esc).join(", ")}) → (${e.fk.references.columns.map(esc).join(", ")})</span></button></li>`).join("");
  const jsonb = Object.entries(t.jsonb_keys).map(([col, keys]) => `<dt>${esc(col)}</dt>${keys.map((k) => { const i = k.indexOf(": "); return `<dd>${i > 0 ? `<code>${esc(k.slice(0, i))}</code>: ${esc(k.slice(i + 2))}` : esc(k)}</dd>`; }).join("")}`).join("");
  const caps = t.capabilities.map((id) => {
    const c = CAPS[id];
    if (!c) return `<details class="cap"><summary><code>${esc(id)}</code> Unknown capability</summary></details>`;
    return `<details class="cap"><summary><code>${esc(id)}</code><span>${esc(c.name)}</span></summary><div class="cap-body"><p>Group ${esc(c.group)} · ${c.persists ? "persistent" : "behavior only"}${c.history ? ` · history: ${esc(c.history)}` : ""}</p><ul>${c.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul><p style="margin-top:6px">Features: ${c.features.map(esc).join(", ")}</p></div></details>`;
  }).join("");
  const section = (title, html, dot) => html ? `<section><h3>${dot ? `<span class="dot" style="background:var(${dot})" aria-hidden="true"></span>` : ""}${title}</h3>${html}</section>` : "";
  panel.innerHTML = `
    <div class="p-head">
      <div class="p-top"><span class="p-dom"><span class="swatch" style="--h:${t.dom.hue}" aria-hidden="true"></span>${esc(t.dom.name)} domain${t.library_owned ? " · owned by the auth library" : ""}</span>
      <button type="button" class="p-close" id="p-close" aria-label="Close details"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <h2 id="p-title" tabindex="-1">${esc(t.name)}</h2>
      <p class="p-meta">${t.columns.length} columns · ${t.foreign_keys.length} foreign keys · referenced by ${t.in.length}</p>
    </div>
    <div class="p-body">
      <section><h3>Purpose</h3><p class="purpose">${esc(t.purpose)}</p><p class="replaces">${t.replaces.length ? `Replaces previous target tables: ${t.replaces.map((r) => `<code>${esc(r)}</code>`).join(", ")}` : "New table; replaces no previous target table."}</p></section>
      ${section(`Columns (${t.columns.length})`, `<table class="cols-t"><caption class="visually-hidden">Columns of ${esc(t.name)}</caption><thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Null</th></tr></thead><tbody>${cols}</tbody></table>`)}
      ${section("Keys", `<ul class="plain"><li><span class="muted">Primary key</span> <code>(${t.primary_key.map(esc).join(", ")})</code></li>${uniques ? `<li class="muted">Unique keys</li>${uniques}` : ""}</ul>`)}
      ${section(`References (${t.foreign_keys.length})`, outs ? `<ul class="rel-list">${outs}</ul>` : "", "--out")}
      ${section(`Referenced by (${t.in.length})`, ins ? `<ul class="rel-list">${ins}</ul>` : "", "--in")}
      ${section(`Checks (${t.checks.length})`, t.checks.length ? `<ol class="checks">${t.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>` : "")}
      ${section("JSONB keys", jsonb ? `<dl class="jsonb">${jsonb}</dl>` : "")}
      ${section(`Capabilities served (${t.capabilities.length})`, caps)}
    </div>`;
  panel.hidden = false;
  panel.scrollTop = 0;
  $("p-close").addEventListener("click", () => closePanel(true));
}
$("panel").addEventListener("click", (e) => {
  const name = e.target.closest("[data-goto]")?.dataset.goto;
  if (!name) return;
  select(byName.get(name), { reveal: true, focusPanel: true, opener });
});

/* ---------- Search ---------- */
function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}
function setQuery(q) { $("q").value = q; onQuery(); }
function onQuery() {
  state.query = $("q").value.trim().toLowerCase();
  $("q-clear").hidden = !state.query; $("q-kbd").hidden = !!state.query;
  for (const t of tables) renderCols(t);
  if (state.sel) drawTop();
  renderSearch();
}
function renderSearch() {
  const q = state.query;
  world.classList.toggle("has-query", !!q);
  const list = $("results"), status = $("search-status");
  if (!q) { list.innerHTML = ""; status.textContent = ""; for (const t of tables) t.card.classList.remove("match"); return; }
  const hits = [];
  for (const t of tables) {
    const n = t.name.toLowerCase();
    const cols = t.columns.filter((c) => c.name.toLowerCase().includes(q));
    const rank = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : cols.length ? 3 : -1;
    t.card.classList.toggle("match", rank >= 0);
    if (rank >= 0) hits.push({ t, cols, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || b.cols.length - a.cols.length || a.t.name.localeCompare(b.t.name));
  const hiddenHits = hits.filter((h) => state.hidden.has(h.t.dom.id)).length;
  status.textContent = hits.length
    ? `${hits.length} table${hits.length === 1 ? "" : "s"} match “${$("q").value.trim()}”${hiddenHits ? `; ${hiddenHits} in hidden domains` : ""}.`
    : `No table or column matches “${$("q").value.trim()}”.`;
  list.innerHTML = hits.slice(0, 60).map(({ t, cols }) => {
    const shown = cols.slice(0, 4).map((c) => highlight(c.name, q)).join(", ") + (cols.length > 4 ? `, and ${cols.length - 4} more` : "");
    return `<li><button type="button" data-t="${esc(t.name)}" aria-current="${state.sel === t}"><span class="r-name">${highlight(t.name, q)}</span><span class="r-meta"><span class="swatch" style="--h:${t.dom.hue}" aria-hidden="true"></span>${esc(t.dom.name)}${state.hidden.has(t.dom.id) ? " (hidden)" : ""}${cols.length ? ` · ${cols.length} matching column${cols.length === 1 ? "" : "s"}` : ""}</span>${cols.length ? `<span class="r-cols">${shown}</span>` : ""}</button></li>`;
  }).join("") + (hits.length > 60 ? `<li class="r-meta" style="padding:6px 8px">Showing 60 of ${hits.length}. Refine the search to see more.</li>` : "");
}
$("q").addEventListener("input", onQuery);
$("q").addEventListener("keydown", (e) => {
  const first = $("results").querySelector("button");
  if (e.key === "Enter" && first) { e.preventDefault(); select(byName.get(first.dataset.t), { reveal: true, focusPanel: false, opener: first }); }
  else if (e.key === "ArrowDown" && first) { e.preventDefault(); first.focus(); }
  else if (e.key === "Escape" && state.query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
});
$("q-clear").addEventListener("click", () => { setQuery(""); $("q").focus(); });
$("results").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (b) select(byName.get(b.dataset.t), { reveal: true, focusPanel: e.detail === 0, opener: b });
});
$("results").addEventListener("keydown", (e) => {
  const buttons = [...$("results").querySelectorAll("button")];
  const i = buttons.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === "ArrowDown" && i < buttons.length - 1) { buttons[i + 1].focus(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { (i ? buttons[i - 1] : $("q")).focus(); e.preventDefault(); }
});

/* ---------- Start ---------- */
buildCanvas();
layout();
apply();
fit();
const fromHash = byName.get(decodeURIComponent(location.hash.slice(1)));
if (fromHash) setTimeout(() => select(fromHash, { reveal: true }), reduceMotion ? 0 : 260);
addEventListener("hashchange", () => { const t = byName.get(decodeURIComponent(location.hash.slice(1))); if (t && t !== state.sel) select(t, { reveal: true }); });
})();
</script>
</body>
</html>
'''


if __name__ == '__main__':
    sys.exit(main())
