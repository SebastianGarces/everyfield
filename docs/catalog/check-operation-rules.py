#!/usr/bin/env python3
"""Audit the inventory reduction against its pre-fix Git revision.

Run with --report <outside-repository path> for every removed field's disposition.
The baseline stays in Git, rather than retaining a second operation catalog.
"""
import argparse
from functools import lru_cache
import collections
import json
from pathlib import Path
import re
import subprocess

BASE = '3885782ebd1402f85d8ec17df8f4f1b2e9ad6146'
ROOT = Path(__file__).resolve().parents[2]
INVENTORY_KEYS = {'id', 'purpose', 'feature_ids', 'owning_package', 'evry_packages',
                  'kind', 'authority', 'changes', 'durable_write', 'evry_review',
                  'evry', 'model_tool', 'privacy_exclusion', 'case_ids'}
SHAPE_KEYS = {'version', 'domain', 'acceptance_ids', 'ownership', 'surface_class',
              'requirement_ids', 'ownership_override_rule', 'model_tool_dispatch',
              'input_closed', 'reject_unrecognized_fields', 'delegates_to',
              'compatibility_rule'}
TOP_SHAPES = {'schema_version', 'status', 'authority', 'field_sets',
              'unmapped_source_target_aliases', 'surface_counts', 'model_tool_names',
              'named_domain_operation_count', 'applied_current_overlays',
              'reviewed_override_ids', 'runtime_semantic_audit', 'ownership_resolution',
              'exposure_counts', 'removed_redundant_product_operations',
              'checklist_canonical_aliases'}
# Context restored from the named fields in the pre-fix catalog. The audit locates
# these complete sentences instead of accepting the old context-free fragments.
RULE_REWRITES = {'3 for critical journeys; 1..3 otherwise': 'Evaluation runs repeat critical journeys three times '
                                            'and other journeys one to three times.',
 'command executor exposed: false.': 'Model tools expose no command executor.',
 'approval exposed: false.': 'Model tools expose no approval capability.',
 'arbitrary code network filesystem sql exposed: false.': 'Model tools expose no arbitrary code, '
                                                          'network, filesystem or SQL capability.',
 'Explicit native purpose-bound POST': 'Email opt-out requires an explicit native request bound to '
                                       'the opt-out purpose.',
 'fixed trusted self; never caller-selectable': 'The notification recipient is the trusted '
                                                'authenticated account and cannot be selected by '
                                                'the caller.',
 'Required team, must null churchwide.': 'A team-scoped training program requires the authorized '
                                         'team; a churchwide program has no team.',
 'Redo only; omitted revoke.': 'The completion date is required when redoing training and omitted '
                               'when revoking completion.',
 'private care: false.': 'Shared model context excludes private care.',
 'no zero substitution: true.': 'Shared reads never substitute zero for unavailable or unmeasured '
                                'data.',
 'current permission rechecked: true.': 'Shared reads recheck current permission before returning '
                                        'data.',
 'generic no-enumeration request outcome': 'Password recovery returns a generic outcome that does '
                                           'not reveal whether the account exists.',
 'one atomic relationship receipt': 'Responding to a relationship invitation commits the '
                                    'relationship decision and its receipt together.',
 'bounded cancellation/status during30day hold': 'During the 30-day personal deletion hold, '
                                                 'restricted access permits only deletion status '
                                                 'and timely cancellation.',
 'exact current organization_sharing_settings.revision': 'Changing organization sharing settings '
                                                         'requires the current revision of the '
                                                         'exact affiliation consent.',
 'own current plant seat': 'Workspace deletion requires the requesting Owner to hold a current '
                           'seat in that plant.',
 'Required contacted only.': 'The actual contact instant is required only when correcting to a '
                             'contacted outcome.',
 'canonical administrative correction receipt': 'Administrative RSVP correction returns the '
                                                'canonical correction receipt.',
 'own task outcome/checklist only': 'A task assignee may change only the outcome and checklist of '
                                    'their own task.',
 'bounded registered internal protocol': 'Assessment consequences run only through the bounded '
                                         'registered internal protocol.',
 'Required whenever ministryAreaKeys changes.': "Changing a role's ministry areas requires the "
                                                'current mapping revision.',
 'own team operational floor': 'A team leader may capture attendance only within the operational '
                               'access allowed for their own team.',
 'ordered sections/id/title/minutes,total/default-version and revision': 'Agenda reads return '
                                                                         'ordered sections with '
                                                                         'their identities, titles '
                                                                         'and minutes, the total '
                                                                         'duration, copied default '
                                                                         'version and current '
                                                                         'revision.',
 'current agenda revision receipt': 'Replacing an agenda returns a receipt with the current agenda '
                                    'revision.',
 'required iff correct': 'Correcting signal evidence requires replacement evidence; other signal '
                         'actions do not require it.',
 'null=bounded own portfolio': 'Omitting a plant selection restricts the health read to the '
                               "caller's authorized portfolio.",
 'current plant launch-progress evidence': 'Reporting-region candidates use current '
                                           'launch-progress evidence for the authorized plant.',
 'null=latest valid complete': 'Omitting an organization assessment selection returns the latest '
                               'valid complete assessment.',
 'presentation context only': 'The requested organization view affects presentation only and '
                              'grants no refresh authority.',
 'bounded oversight/shared Network Intelligence': 'Published organization launch summaries contain '
                                                  'only bounded oversight and shared Network '
                                                  'Intelligence evidence.',
 'not summarized after removal: true.': 'Fact snapshots must not summarize sources removed from '
                                        "the caller's authorized evidence.",
 'eligible valid completion<=start+48h inclusive': 'The timeliness numerator includes only '
                                                   'eligible valid task completions no later than '
                                                   '48 elapsed hours after the actual originating '
                                                   'occurrence.',
 'allowedHistoryRecordTypes: ordinary_note, ordinary_activity, own_allowed_follow_up.': 'Person '
                                                                                        'activity '
                                                                                        'history '
                                                                                        'contains '
                                                                                        'only '
                                                                                        'ordinary '
                                                                                        'notes, '
                                                                                        'ordinary '
                                                                                        'activities '
                                                                                        'and '
                                                                                        'follow-up '
                                                                                        'history '
                                                                                        'allowed '
                                                                                        'for the '
                                                                                        'caller.',
 'household+head receipt, no orphan': 'Household creation commits the household and its head '
                                      'membership together and returns a receipt without leaving '
                                      'an orphan household.',
 'ended current household membership/history': 'Removing a person from a household ends their '
                                               'current membership and preserves its history.',
 'reject supplied original actor/provenance': 'Interview recording rejects caller-supplied '
                                              'original actor or provenance.',
 'no model/client call': 'Recorded recruitment events can be applied only by the trusted internal '
                         'producer, never by a model or client call.',
 'Evaluation task null.': 'A managed evaluation task has no person target.',
 'fixed exact current plant': 'Plant sharing requests bind the plant to the exact current '
                              'authorized plant.',
 'fixed exact current organization': 'Organization sharing requests bind the organization to the '
                                     'exact current authorized organization.',
 'Supported category values: bug, suggestion, question, other[].': 'Feedback category filters '
                                                                   'accept only bug, suggestion, '
                                                                   'question and other.'}
LIST_COUNT_RULE = 'List totals, counts and group buckets come from the authorized database query, never from returned pages or selected rows; a deliberately unmeasured count is null, and an unavailable read returns unavailable, never zero.'

TYPE_KEYS = {'type', 'fields', 'projected_fields', 'result_projection', 'closed',
             'required_parameters', 'additional_parameters', 'mode', 'storage',
             'operation', 'kind', 'source', 'status', 'authority', 'forbidden_input_fields'}


def load_base(path, base=BASE):
    return json.loads(subprocess.check_output(['git', '-C', str(ROOT), 'show', base + ':' + path]))


def canonicalizer(aliases, operations):
    mapping = {a['alias']: a['canonical_operation'] for a in aliases['aliases']
               if a['alias'] != a['canonical_operation']}
    mapping.update(operations.get('checklist_canonical_aliases', {}))
    pattern = re.compile(r'(?<![\w.])(?:' + '|'.join(re.escape(x) for x in sorted(mapping, key=len, reverse=True)) + r')(?![\w.])')
    def replace(text):
        for _ in range(3):
            text = pattern.sub(lambda m: mapping[m[0]], text)
        return text
    return replace, pattern


def align(text):
    # Physical identifiers follow Fix 2; ordinary revision/worker fences remain valid.
    text = text.replace('authorizationRevision', 'current authority').replace('authorization_revision', 'current authority')
    text = text.replace('authFence', 'current authority').replace('auth_fence', 'current authority')
    return text


TRANSACTION_PREFIX = 'One short caller-owned domain transaction rechecks exact current authority/subject/revisions, writes current state, attributable domain history, synchronous material revision, command receipt/audit and required intents; provider/model outside transaction. '


def behavior_text(text):
    # This repeated mechanism is already specified once in core.md.
    return text.removeprefix(TRANSACTION_PREFIX)


def parameter_rule(text):
    # Preserve qualifications in prose while retiring the named input types.
    match = re.fullmatch(r'[A-Z][\w|→]+ \((.*)\)', text)
    if match:
        return match[1][0].upper() + match[1][1:] + '.'
    return {
        'AuthenticatedSelfAccountId for account; exact current authorized plant/organization ID otherwise':
            'Account context uses authenticated self; other contexts require the exact currently authorized plant or organization.',
        'OwnAccountPerson scalar, not arbitrary internal account link':
            'Return only the own-account Person link, never an arbitrary internal account link.',
    }.get(text, text)


def narrative(value, path=''):
    """Keep domain restrictions, not a copied parameter/result schema."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in TYPE_KEYS:
                continue
            yield from narrative(child, path + '.' + key)
    elif isinstance(value, list):
        if value and all(isinstance(x, str) for x in value):
            # Allow/deny lists are behavior; ordinary DTO field layout is not.
            if any(k in path.lower() for k in ['forbidden', 'remove', 'allow', 'exclude', 'signalkey']):
                yield path.rsplit('.', 1)[-1].replace('_', ' ') + ': ' + ', '.join(value) + '.'
            else:
                for child in value:
                    yield from narrative(child, path)
        else:
            for child in value:
                yield from narrative(child, path)
    elif isinstance(value, str):
        if len(value.split()) >= 4:
            # A semicolon after a type introduces a behavioral qualification.
            if re.match(r'^[A-Z]\w*(?:\[.*?\])?(?:\|null)?;', value):
                value = value.split(';', 1)[1].strip()
            yield value
        elif '|' in value and not re.search(r'[A-Z]|null|boolean|string', value):
            yield 'Supported ' + path.rsplit('.', 1)[-1] + ' values: ' + value.replace('|', ', ') + '.'
    elif isinstance(value, bool) and any(k in path for k in ['exposed', 'permission', 'private_care', 'zero_substitution', 'summarized']):
        yield path.rsplit('.', 1)[-1].replace('_', ' ') + ': ' + str(value).lower() + '.'


def removed_fields(before, aliases):
    replace, _ = canonicalizer(aliases, before)
    atomicities = collections.Counter(o['atomicity'] for o in before['operations'])
    for op in before['operations']:
        for key, value in op.items():
            if key in ['id', 'feature_ids', 'case_ids', 'kind', 'model_tool', 'entry_points']:
                continue
            if key == 'authority':
                # Actor/scope stays in inventory. Actor-specific visibility belongs to requirements.
                rules = []
                for a in value:
                    if a['fields'] not in [op['result'].get('fields', [])] or 'member' in a['actor']:
                        rules.append('Visible information for ' + a['actor'] + ': ' + ', '.join(a['fields']) + '.')
                    if not a['purpose'].startswith(('Current authorized ', 'native operational work')):
                        rules.extend(narrative(a['purpose']))
                yield op, key, value, [align(replace(x)) for x in rules], 'actor/scope retained; signature shape is builder choice'
            elif key == 'result' and any(k in value for k in ['count_semantics', 'mode_contract']):
                yield op, key, value, [LIST_COUNT_RULE], 'result layout is builder choice; authorized count semantics live once in core.md'
            elif key in SHAPE_KEYS or key in ['purpose', 'parameters', 'result']:
                rules = [parameter_rule(x) for x in narrative(value)] if key == 'parameters' else []
                yield op, key, value, [align(replace(x)) for x in rules], 'signature, layout or duplicate metadata is builder choice'
            elif key == 'review':
                rules = []
                if not value['scope'].startswith(('Exact ', 'exact ')):
                    rules.append(value['scope'])
                if value['before_execution'].startswith('Verify current lifecycle'):
                    rules.append(value['before_execution'])
                yield op, key, value, [align(replace(x)) for x in rules], 'review flag retained; shared review boundary in core.md; profile mechanics are builder choice'
            elif key in ['errors', 'error_contract', 'parameter_common', 'input_contract']:
                yield op, key, value, [], 'shared boundary/review/error rules in docs/architecture/core.md; exact types and profile are builder choice'
            elif key == 'atomicity' and atomicities[value] >= 19:
                yield op, key, value, [], 'shared transaction/read/private-protocol rules in docs/architecture/core.md; mechanics are builder choice'
            else:
                yield op, key, value, [align(replace(behavior_text(x))) for x in narrative(value, key)], 'domain behavior retained; exact encoding is builder choice'
    for key, value in before.items():
        if key == 'operations':
            continue
        rules = [] if key in TOP_SHAPES else [align(replace(x)) for x in narrative(value, key)]
        yield None, key, value, rules, 'shared catalog behavior retained; catalog bookkeeping and type layout are builder choice'
    for alias in aliases['aliases']:
        # Adaptation schemas disappear, but their extra predicates cannot disappear with them.
        for key, value in alias.items():
            rules = list(narrative(value, key)) if key in ['canonical_input_validation', 'current_authority_rule', 'context_projection', 'canonical_parameters', 'default_context_rule'] else []
            if key == 'result_transform' and value != 'Return exact canonical result below under current purpose projection; no generic QueryPage or CommandReceipt substitution.':
                rules = list(narrative(value, key))
            if key == 'equivalence' and isinstance(value, str) and ('does not' in value or 'never' in value):
                rules = list(narrative(value, key))
            if key == 'canonical_parameters':
                rules = [parameter_rule(x) for x in rules]
            yield {'id': alias['canonical_operation']}, 'alias.' + alias['alias'] + '.' + key, value, [align(replace(parameter_rule(x))) for x in rules], 'canonical reference replaces alias; adaptation types/transforms are builder choice'


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


FIX6_RULE_REWRITES = {
  "Closed authenticated intake stores private original and trusted author; subject optional, page canonicalized to approved internal route stripping query/fragment. Stored success distinct from public publication/implementation.": "The dialog stores category, description and private page/address/church/role/browser/screen/theme/version/time details with a trusted author. Canonicalize the internal address by stripping query, fragment and tokens. No screenshot or attachment is accepted. Stored success is distinct from public publication or implementation; diagnostics never enter the public issue.",
  "One CAS transaction persists supported insights/overall summary/completion/current pointer/required intents. Check source, reference activation, current claim/lease/lifecycle and every exact-org current contributor grant. Plant publication changes projection, never its own source material revision.": "One CAS transaction persists supported findings, overall summary, completed assessment, availability and required intents. Check source, reference activation, current claim/lease/lifecycle and every exact-org current contributor grant. Plant publication changes projection, never its own source material revision.",
  "Current claim/status CAS; complete result cannot be demoted, and prior current pointer is unchanged. No hidden generic retry/publication grant.": "Current claim/status CAS; complete result cannot be demoted, and prior valid completed result remains available. No hidden generic retry/publication grant.",
  "Commit against current live linked ordinary Tasks and source evidence; race/reopen correction preserves history and Needs-review truth, no new Task status engine.": "Commit against the current linked-task digest and source evidence. Open linked tasks are allowed; a changed digest refuses a stale reviewed view. Reopening or correction preserves history and Needs-review evidence without creating a second Task status engine.",
  "Unique(worship|childrens|assimilation|small_groups|admin_finance|facilities|promotion|technology)[] (explicit saved custom responsibility mapping; [] clears; never guessed from name; Prayer remains separate and is not ninth area)?": "A role may have an explicit saved set of distinct ministry areas: worship, childrens, assimilation, small_groups, admin_finance, facilities, promotion and technology. An empty set clears the mapping. Never infer it from the role name; Prayer remains separate and is not a ninth area.",
  "Plant: publish complete paired assessment and plant pointer/projection; increment only affected organization material inputs. Organization: publish aggregate-safe finding/slices and exact-org pointer; do not recursively invalidate own material source.": "Plant publication completes the paired assessment and its availability; increment only affected organization material inputs. Organization publication completes aggregate-safe findings/slices and assessment availability; do not recursively invalidate its own material source. Current projections derive from eligible complete rows, with no separately mutable pointer."
}


@lru_cache(maxsize=1)
def behavior_rewrites():
    # Only exact reviewed old-to-new ledger pairs may translate historical rules.
    ledger = json.loads((ROOT / 'docs/catalog/rule-placement.json').read_text())
    rewrites = {re.sub(r'\s+', '', old): new for old, new in ledger['rewrites'].items()}
    return rewrites


def behavior_language(rule):
    return behavior_rewrites().get(re.sub(r'\s+', '', rule), rule)


def current_rule(rule):
    """Apply the reviewed Fix 6 prose corrections to historical rule evidence."""
    rule = FIX6_RULE_REWRITES.get(rule, RULE_REWRITES.get(rule, rule))
    # Physical names and measured-load staging follow the approved round-2 model.
    for old, new in [('email_intent', 'mail'), ('command_receipt', 'operation'), ('task_status_event', 'event')]:
        rule = re.sub(r'\b' + old + r'\b', new, rule)
    rule = rule.replace('with fairness/lease/fence/checkpoint',
                        'with finite lease/fence/checkpoint; scheduler fairness tuning belongs to G-LOAD')
    rule = rule.replace('Plant publication completes the paired assessment and its availability; increment only affected organization material inputs.',
                        'Plant publication completes the paired assessment and its availability; organization publication compares the current contributor source revisions without advancing organization material revision for a source-only change.')
    rule = rule.replace('Release eligibility and affected exact-org material revision commit transactionally; replay no duplicate.',
                        'Release eligibility commits transactionally; replay creates no duplicate. Organization publication compares current contributor and released source revisions. Only affiliation and sharing changes advance organization material revision.')
    rule = rule.replace('Affected org material input revision bumps atomically. No plant-source self-invalidation.',
                        'Organization publication compares current contributor and released source revisions without advancing organization material revision. Only affiliation and sharing changes advance organization material revision. No plant-source self-invalidation.')
    if rule.startswith('Supported ') and rule.endswith('[].'):
        return behavior_language(rule[:-3] + '.')
    return behavior_language(rule)


def audit(base, report):
    before = load_base('docs/catalog/operations.json', base)
    # Round 2: database triggers supersede this caller-managed command and rule.
    # REQ-PI-037 and assessment.md own trigger-set and freshness obligations.
    retired = 'intelligence.markMaterialRevision'
    before['operations'] = [o for o in before['operations'] if o['id'] != retired]
    aliases = load_base('docs/catalog/current-operation-aliases.json', base)
    catalog = json.loads((ROOT / 'docs/catalog/index.json').read_text())
    files = catalog['requirement_files'] + catalog['case_files']
    texts = {p: '\n'.join(strings(json.loads((ROOT / p).read_text()))) for p in files}
    texts.update({str(p.relative_to(ROOT)): p.read_text() for p in (ROOT / 'docs/architecture').glob('*.md')})
    # Fix 8 repairs prose spacing. Compare historical evidence without whitespace,
    # preserving every non-whitespace character and the original audit scope.
    normalized = {p: re.sub(r'\s+', '', text) for p, text in texts.items()}
    core = texts['docs/architecture/core.md']
    for shared_rule in ['Meaningful domain changes recheck live authority',
                        'Failure of any required write rolls everything back.',
                        'Exact replay returns the original receipt without repeating effects.',
                        'Every durable Evry change requires review of exact effects',
                        'A changed review-sensitive fact supersedes approval.',
                        'Denials reveal no forbidden record existence.',
                        'truthful retry eligibility',
                        'Actor-private Evry conversation',
                        'Authorized pure reads have no durable domain effects', LIST_COUNT_RULE]:
        assert shared_rule in core, 'Shared rule missing: ' + shared_rule
    rows = []
    missing = []
    for op, field, value, rules, choice in removed_fields(before, aliases):
        locations = []
        for rule in rules:
            rule = current_rule(rule)
            targets = [p for p, text in normalized.items() if re.sub(r'\s+', '', rule) in text]
            if not targets:
                missing.append((op['id'] if op else 'catalog', field, rule))
            locations.append({'rule': rule, 'locations': targets})
        rows.append({'operation': op['id'] if op else None, 'removed_field': field, 'source_value': value,
                     'disposition': choice, 'behavior': locations})
    inventory = json.loads((ROOT / catalog['operation_source']).read_text())['operations']
    assert len(inventory) == len({o['id'] for o in inventory}), 'Duplicate inventory operation'
    assert (ROOT / catalog['operation_source']).stat().st_size < 500 * 1024, 'Inventory exceeds the roughly 500 KB budget'
    additions = json.loads((ROOT / 'docs/catalog/rule-placement.json').read_text()).get('operation_additions', [])
    added_ids = {a['id'] for a in additions}
    assert len(added_ids) == len(additions), 'Duplicate operation addition'
    assert not added_ids & {o['id'] for o in before['operations']}, 'Addition already in baseline'
    assert all(a['reason'].strip() for a in additions), 'Operation addition needs a ruling'
    assert {o['id'] for o in inventory} == {o['id'] for o in before['operations']} | added_ids, 'Operation lost or unreviewed addition'
    assert all(set(o) in [INVENTORY_KEYS, INVENTORY_KEYS - {'changes'}] for o in inventory), 'Unexpected inventory contract field'
    tables = {t['name'] for t in json.loads((ROOT / 'docs/schema/target.json').read_text())['tables']}
    omitted = []
    for op in inventory:
        if 'changes' not in op:
            assert op['durable_write'], 'Only unresolved writes may omit changes'
            omitted.append(op['id'])
            continue
        changes = op['changes']
        assert set(changes) == {'records', 'side_effects'}, 'Unexpected effects field'
        assert len(changes['records']) == len(set(changes['records'])), 'Duplicate table for ' + op['id']
        assert set(changes['records']) <= tables, 'Unknown affected table for ' + op['id']
        if op['durable_write']:
            assert changes['records'] and changes['side_effects'], 'Write effects missing for ' + op['id']
        else:
            assert changes == {'records': [], 'side_effects': []}, 'Read claims durable changes'
    assert 'When changes is omitted, linked requirements and cases define the effects' in json.loads((ROOT / catalog['operation_source']).read_text())['authority']
    by_id = {o['id']: o for o in before['operations']}
    replace, _ = canonicalizer(aliases, before)
    for op in inventory:
        if op['id'] in added_ids:
            addition = next(a for a in additions if a['id'] == op['id'])
            requirement = next(r for path in catalog['requirement_files'] for r in json.loads((ROOT / path).read_text())['requirements'] if r['id'] == addition['requirement'])
            assert op['id'] in requirement['operations'] and op['owning_package'] in requirement['work_packages'], 'Addition lacks owning requirement'
            assert op['authority'] and all(r['actors'] and r['rule'].strip() for r in op['authority']), 'Addition lacks caller authority'
            assert op['durable_write'] == (op['kind'] == 'command'), 'Wrong added write classification'
            continue
        original = by_id[op['id']]
        # Fix 6 consolidated per-operation Evry rows into the shared exposure rule.
        expected_features = list(dict.fromkeys(
            'EVR-020' if fid.startswith('EVR-') and int(fid[4:]) >= 100 else fid
            for fid in original['feature_ids']))
        assert op['feature_ids'] == expected_features, 'Changed feature mapping for ' + op['id']
        for key in ['case_ids', 'kind']:
            assert op[key] == original[key], 'Changed ' + key + ' for ' + op['id']
        # Current catalog owns package routing; --check-plan proves owner parity and producer order.
        # Historical package assignments are not a second ownership authority.
        assert op['model_tool'] == bool(original['model_tool']), 'Changed model availability'
        assert op['evry'] == ('evry' in original['entry_points']), 'Changed Evry availability'
        assert op['durable_write'] == (original['kind'] == 'command'), 'Changed durable-write classification'
        assert op['evry_review'] == (op['durable_write'] and op['evry'] and original['review']['required']), 'Changed review rule'
        actors = {(actor, rule['rule']) for rule in op['authority'] for actor in rule['actors']}
        assert actors == {(rule['actor'], behavior_language(align(replace(rule['scope'])))) for rule in original['authority']}, 'Changed caller authority'
    assert next(o for o in inventory if o['id'] == 'emailSuppression.requestRestore')['owning_package'] == 'WP-028'
    assert not (ROOT / 'docs/catalog/current-operation-aliases.json').exists(), 'Alias file survives'
    _, pattern = canonicalizer(aliases, before)
    for p in list((ROOT / 'docs/product').glob('*.md')) + list((ROOT / 'docs/catalog/requirements').glob('*.json')):
        assert not pattern.search(p.read_text()), 'Alias remains in ' + str(p)
        if p.suffix == '.md':
            for number, line in enumerate(p.read_text().splitlines(), 1):
                if line.startswith('**Target operations:**'):
                    ids = re.findall(r'`([^`]+)`', line)
                    assert len(ids) == len(set(ids)), f'Duplicate chapter operation: {p}:{number}'
                    assert not re.search(r', \.', line), f'Empty chapter operation: {p}:{number}'
        else:
            for req in json.loads(p.read_text()).get('requirements', []):
                ids = req.get('operations', [])
                assert len(ids) == len(set(ids)), 'Duplicate requirement operation: ' + req['id']
                assert set(ids) <= set(by_id) | added_ids, 'Unknown requirement operation: ' + req['id']
                for rule in req.get('behavior_rules', []):
                    assert rule['rule'] not in RULE_REWRITES, 'Context-free rule survives: ' + req['id']
                    assert not re.search(r': (true|false)\.', rule['rule']), 'Mechanical boolean rule: ' + req['id']
    if report:
        report.write_text(json.dumps({'base': base, 'fields': rows, 'missing': missing, 'omitted_changes': omitted}, indent=2) + '\n')
    if missing:
        raise SystemExit('Missing behavior rules: ' + json.dumps(missing[:8]))
    print(f'PASS: {len(omitted)} unresolved writes omit changes; {len(rows)} removed fields classified; {sum(len(r["behavior"]) for r in rows)} behavior rules located; all {len(inventory)} operations and canonical references retained.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    audit(args.base, args.report)
