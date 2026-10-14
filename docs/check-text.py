#!/usr/bin/env python3
"""Check current Markdown and JSON prose for damaged spacing without writing files.

Originals listed in reference/manifest.json, code, links, IDs and type names are
outside this check. text-allowlist.json records reviewed technical exceptions.
"""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
PROSE_KEYS = {'text', 'title', 'description', 'purpose', 'rule', 'meaning', 'behavior',
              'question', 'closure', 'notes', 'summary', 'expected', 'fixture'}
SPLIT_WORDS = {
    'at ten dee': 'attendee', 'edit able': 'editable', 'sup plied': 'supplied',
    'spread sheet': 'spreadsheet', 'con tactuses': 'contact uses',
    'DTO s': 'DTOs', 'URL s': 'URLs', 'allow listed': 'allowlisted',
    'allow list': 'allowlist',
}
# Observed corruptions, deliberately not a spellchecker or a compound-word ban.
JOINED_WORDS = {
    'notan': 'not an', 'nothheld': 'not held', 'remainnot_started': 'remain not_started',
    'physicalday': 'physical day', 'elapsedhours': 'elapsed hours',
    'elapsedhour': 'elapsed hour', 'pertenantpage': 'per tenant page',
    'pertenant': 'per tenant', 'millionchars': 'million chars',
    'milliontext': 'million text', 'IPhour': 'IP hour',
    'MiBexpanded': 'MiB expanded', 'localdays': 'local days',
    'Aggregateheadcount': 'Aggregate headcount',
    'Scheduledfuture': 'Scheduled future', 'andEvry': 'and Evry',
    'XLSXclaim': 'XLSX claim', 'RPO1h': 'RPO 1h', 'RTO4h': 'RTO 4h',
    'USDcredit': 'USD credit', 'noHobby': 'no Hobby',
    'unverifiedZDR': 'unverified ZDR', 'RSCactionclosures': 'RSC action closures',
    'byQ': 'by Q', 'whileB': 'while B',
    'DBclock': 'DB clock', 'DBcommit': 'DB commit', 'DBfinalization': 'DB finalization',
    'DBplusbyte': 'DB plus byte', 'DBplusfilesrestore': 'DB plus files restore',
    'DSTcalendar': 'DST calendar', 'DSTdue': 'DST due', 'DSTfold': 'DST fold',
    'CRMtitle': 'CRM title', 'CSVformula': 'CSV formula', 'FKwrite': 'FK write',
    'GETmutation': 'GET mutation', 'IDinjection': 'ID injection',
    'NIrawmanifest': 'NI raw manifest', 'PRrouting': 'PR routing',
    'PUBLICfeedback': 'PUBLIC feedback', 'PUBLICrepo': 'PUBLIC repo',
    'RSVPholds': 'RSVP holds', 'UAon': 'UA on', 'auditUPDATE': 'audit UPDATE',
    'coherentDB': 'coherent DB', 'disasterRTO': 'disaster RTO',
    'privateTigris': 'private Tigris', 'nativeSQL': 'native SQL',
    'ownedBetterAuth': 'owned Better Auth', 'decompressionheavyOffice': 'decompression heavy Office',
    'executableMDX': 'executable MDX', 'lastOwneraccount': 'last Owner account',
    'realPDF': 'real PDF', 'noBYPASSRLS': 'no BYPASSRLS',
    'unknownproviderIDs': 'unknown provider IDs', 'staleEvryreview': 'stale Evry review',
    'withBdirectgrant': 'with B direct grant', 'plantlocalWiki': 'plant local Wiki',
    'categoryemailON': 'category email ON', 'orgsharedfindingsON': 'org shared findings ON',
    'coreAlex': 'core Alex', 'acquisitionOctober': 'acquisition October',
    'withdrawalOctober': 'withdrawal October', 'meetingMarch': 'meeting March',
    'requestOctober': 'request October', 'purgeNovember': 'purge November',
    'endsSeptember': 'ends September', 'toSteady': 'to Steady', 'orSteady': 'or Steady',
    'answerYes': 'answer Yes', 'missingYes': 'missing Yes', 'validNo': 'valid No',
    'hRPO': 'h RPO', 'hRTO': 'h RTO', 'dayPITR': 'day PITR',
    'daydeletedobjects': 'day deleted objects', 'hourembargoed': 'hour embargoed',
}
# Add only visibly joined prose; identifiers with these spellings remain intact.
JOINED_PHRASES = '''
accountdisaster=account disaster
actorlinks=actor links
actualcount=actual count
actualexecution=actual execution
actualnonfuture=actual nonfuture
actualrepo=actual repo
advancedphase=advanced phase
afterfailure=after failure
aggregatecount=aggregate count
anotherapproval=another approval
arbitrarymanualsignal=arbitrary manual signal
asyncwake=async wake
attemptstartupwipe=attempt startup wipe
auditcleanup=audit cleanup
automaticimplementation=automatic implementation
automaticmerge=automatic merge
automaticmodelredaction=automatic model redaction
availablemodelresult=available model result
backupbucket=backup bucket
beforeaccount=before account
beforecustomerdata=before customer data
betweencreate=between create
boundedattemptdeadline=bounded attempt deadline
boundedsubmission=bounded submission
canceledscheduledmail=canceled scheduled mail
calleractor=caller actor
changedidem=changed idem
claimedstore=claimed store
clientactorheaders=client actor headers
clientkey=client key
codingrequest=coding request
coherentrestore=coherent restore
completedactualpractice=completed actual practice
concurrentattendance=concurrent attendance
configuredtested=configured tested
cookiehandling=cookie handling
correctedanswer=corrected answer
costapproval=cost approval
crossownerintent=cross owner intent
crossscope=cross scope
currentclaim=current claim
currentgrant=current grant
currentorg=current org
currentorgeditor=current org editor
customerclone=customer clone
customorgversion=custom org version
dailycopy=daily copy
datedactor=dated actor
debriefquestionnaire=debrief questionnaire
deferredcoach=deferred coach
deletedobject=deleted object
deletedsubject=deleted subject
deletionwitness=deletion witness
departedcurrentbody=departed current body
differenttenant=different tenant
distinctfromreader=distinct from reader
domainclaim=domain claim
draftsave=draft save
duplicateevents=duplicate events
editableotherreadiness=editable other readiness
eligiblehuman=eligible human
emailchange=email change
emptyoptional=empty optional
encrypteddaily=encrypted daily
endsone=ends one
entitledalternate=entitled alternate
entitledorgfork=entitled org fork
exactdeadline=exact deadline
exactobject=exact object
exactorg=exact org
exactplant=exact plant
exactplantpurge=exact plant purge
exfiltrationinstruction=exfiltration instruction
expectedactivation=expected activation
expectedrevision=expected revision
expiredhandle=expired handle
expiredreview=expired review
explicitpublish=explicit publish
externalcopy=external copy
externalmail=external mail
externalreceipt=external receipt
externalreceipts=external receipts
featurefeedback=feature feedback
filemetadata=file metadata
firstdispatch=first dispatch
firstservice=first service
forceddeadline=forced deadline
foreignactor=foreign actor
foreignparent=foreign parent
forgedactor=forged actor
formerorg=former org
fullcandidate=full candidate
generatedfile=generated file
genericplatformadmin=generic platform admin
globalbridge=global bridge
globalvsorgcorpuscache=global vs org corpus cache
guessedobject=guessed object
guestcriterion=guest criterion
hostschedule=host schedule
humanopened=human opened
humanoperationalsummary=human operational summary
implicittraining=implicit training
independentlyhosted=independently hosted
independentplatform=independent platform
individualguest=individual guest
interveningtypo=intervening typo
invalidappend=invalid append
jobclaim=job claim
keyescrow=key escrow
lastcommittedwork=last committed work
latestresult=latest result
leadtitle=lead title
limiterburst=limiter burst
liveguard=live guard
localreceiptfailure=local receipt failure
longcontext=long context
maintenancehost=maintenance host
meaningfularticleupdate=meaningful article update
meaningfulflag=meaningful flag
migrationprincipal=migration principal
mismatchedfile=mismatched file
missingcontext=missing context
missingguestanswer=missing guest answer
missingguests=missing guests
missingnameanswer=missing name answer
missingtarget=missing target
modelcost=model cost
modeltrace=model trace
monthlyusage=monthly usage
namedcreate=named create
namedguest=named guest
namedguests=named guests
nativefeedback=native feedback
nativepractice=native practice
newmodelassessment=new model assessment
newplant=new plant
newrequest=new request
newsource=new source
nextsteptask=next step task
noemail=no email
normalsession=normal session
numericbudget=numeric budget
objectlock=object lock
objectversion=object version
oldcompletedcredit=old completed credit
oldcopy=old copy
oldreference=old reference
oldrequest=old request
oldrevision=old revision
omittedvsnull=omitted vs null
orderwrite=order write
orgeditor=org editor
orgending=org ending
orgrelationship=org relationship
orgsharing=org sharing
orplant=or plant
otherorg=other org
outoforder=out of order
outsideorg=outside org
overmeeting=over meeting
ownerbypass=owner bypass
ownertriage=owner triage
ownfeedback=own feedback
ownorg=own org
pagedolderhistory=paged older history
paidplan=paid plan
parentchurch=parent church
pendingmail=pending mail
pendingupload=pending upload
personphoto=person photo
plannedtarget=planned target
plantname=plant name
plantpurge=plant purge
positivecount=positive count
practicewrite=practice write
preferencegrant=preference grant
previewreview=preview review
privateartifacts=private artifacts
privatebody=private body
privatecare=private care
promptattachmentcanaries=prompt attachment canaries
provideracceptance=provider acceptance
publicissue=public issue
publicoperationalsummary=public operational summary
publishedchange=published change
publishedglobal=published global
publishednewrevision=published new revision
purgelease=purge lease
rawpublication=raw publication
rawquestionnaire=raw questionnaire
rawreflection=raw reflection
regardlessordinaryprefs=regardless ordinary prefs
repeatedcreate=repeated create
reportedmissingcount=reported missing count
reportedremaining=reported remaining
requiredoperator=required operator
restartchangedproposal=restart changed proposal
restoredbranch=restored branch
restrictedhost=restricted host
restrictedkey=restricted key
resultembargo=result embargo
retainedtable=retained table
reviewcue=review cue
reviewedmove=reviewed move
reviewedsummarypublication=reviewed summary publication
reviewedwrite=reviewed write
reviewexpiry=review expiry
revokedactor=revoked actor
revokedcategory=revoked category
revokededitor=revoked editor
revokedgrant=revoked grant
revokedsource=revoked source
revokegrant=revoke grant
roleunion=role union
rostercounts=roster counts
runsnon=runs non
sametitle=same title
scheduledmail=scheduled mail
scheduledsend=scheduled send
scopedinvestigator=scoped investigator
scriptinjection=script injection
secondaffiliatevalid=second affiliate valid
selectedteams=selected teams
sentmail=sent mail
separateinventory=separate inventory
separatepublicfeedbackrepo=separate public feedback repo
separatepublish=separate publish
sharedhistory=shared history
sixarea=six area
sixrules=six rules
softdeletedbucket=soft deleted bucket
sortkey=sort key
sourceunion=source union
sourceversions=source versions
splitreader=split reader
spoofeduser=spoofed user
stagedfile=staged file
stagedregistration=staged registration
staleapprovedplan=stale approved plan
stalecredentialrace=stale credential race
streamresponse=stream response
subjectexpiry=subject expiry
submittedquestionnaire=submitted questionnaire
summarydraftsaved=summary draft saved
summarypublish=summary publish
suppliedname=supplied name
survivingindependent=surviving independent
teamhealth=team health
teamleader=team leader
teamrehearsal=team rehearsal
telemetryretention=telemetry retention
thenread=then read
unansweredincomplete=unanswered incomplete
uncertainclassification=uncertain classification
unnamedguests=unnamed guests
unscopedoperatorinspect=unscoped operator inspect
unsentintent=unsent intent
unsignedmachine=unsigned machine
unspecifiedworktree=unspecified worktree
uploadintent=upload intent
upstreamcue=upstream cue
upstreamcustomversion=upstream custom version
validhuman=valid human
validsubmit=valid submit
voidduplicate=void duplicate
walltime=wall time
warmcache=warm cache
warmnavigation=warm navigation
withcount=with count
wrongassignee=wrong assignee
'''
JOINED_WORDS.update(line.split('=', 1) for line in JOINED_PHRASES.splitlines() if line)
BAD = re.compile(r'(?<![\w])(?:' + '|'.join(re.escape(x).replace(r'\ ', r'[ \t]+') for x in
                 sorted(SPLIT_WORDS | JOINED_WORDS, key=len, reverse=True)) + r')(?![\w])')
TOKEN = re.compile(r'\b[A-Za-z0-9]+\b')
NUMBER_JOIN = re.compile(r'[a-z]\d|\d[a-z]{3,}')
DECIMAL = re.compile(r'\b\d+\. +\d+\b')
# Mask complete technical units, never individual word fragments within prose.
TECHNICAL = re.compile(
    r'`[^`\n]*`|https?://[^\s<>]+|\]\([^)]*\)|'
    r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|'
    r'\b\d{4}-\d\d-\d\d(?:T[\d:.]+Z)?\b|'
    r'\b[0-9a-f]{7,64}\b|'
    r'\b(?!remainnot_started\b)\w+_\w+(?:[._]\w+)*\b|'
    r'\b[A-Za-z]+(?:\.[A-Za-z_]\w*)+\b|'
    r'\b(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|pi-phase[0-6]-[0-9]+)\b')


def prose(text):
    return TECHNICAL.sub(lambda m: ' ' * len(m.group()), text)


def problems(text, allowed):
    cleaned = prose(text)
    for match in BAD.finditer(cleaned):
        yield match.start(), match.group(), 'damaged word spacing'
    for match in DECIMAL.finditer(cleaned):
        yield match.start(), match.group(), 'split decimal'
    for match in TOKEN.finditer(cleaned):
        token = match.group()
        if token not in allowed and NUMBER_JOIN.search(token):
            yield match.start(), token, 'joined word/number'


def strings(value, pointer='', key=''):
    if isinstance(value, str):
        if ' ' in value or key in PROSE_KEYS or any(word in value for word in SPLIT_WORDS):
            yield pointer, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from strings(item, f'{pointer}/{i}', key)
    elif isinstance(value, dict):
        for name, item in value.items():
            escaped = name.replace('~', '~0').replace('/', '~1')
            yield from strings(item, f'{pointer}/{escaped}', name)


def current_files(root):
    manifest = json.loads((root / 'docs/reference/manifest.json').read_text())
    originals = {item['path'] for item in manifest['files']}
    return sorted(p for p in [root / 'README.md', *(root / 'docs').rglob('*')]
                  if p.suffix in {'.md', '.json'} and p.relative_to(root).as_posix()
                  not in originals | {'docs/text-allowlist.json'})


def check(root):
    allowlist = json.loads((root / 'docs/text-allowlist.json').read_text())
    allowed = set(allowlist['tokens'])
    failures = []
    files = current_files(root)
    for path in files:
        text = path.read_text()
        if path.suffix == '.json':
            portions = strings(json.loads(text))
        else:
            text = re.sub(r'^ *(`{3,}|~{3,}).*?^ *\1[^\n]*$',
                          lambda m: '\n' * m.group().count('\n'), text,
                          flags=re.M | re.S)
            portions = ((str(i), line) for i, line in enumerate(text.splitlines(), 1))
        exceptions = allowed | set(allowlist.get('files', {}).get(
            path.relative_to(root).as_posix(), {}))
        for location, value in portions:
            for offset, token, reason in problems(value, exceptions):
                failures.append(f'{path.relative_to(root)}:{location}:{offset + 1}: '
                                f'{reason}: {token!r}')
    for failure in failures:
        print(failure)
    print(f'{"FAIL" if failures else "PASS"}: text lint, {len(files)} current files, '
          f'{len(failures)} spacing errors; immutable originals excluded.')
    return bool(failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    return check(args.root.resolve())


if __name__ == '__main__':
    raise SystemExit(main())
