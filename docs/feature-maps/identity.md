# Feature map: identity

Generated from [`apps/web/src/features/identity/feature-map.json`](../../apps/web/src/features/identity/feature-map.json) by `node tools/ci/feature-maps.ts --write`. Do not edit by hand.

```mermaid
flowchart LR
  s0_link0(["link /signin"])
  s1_link0(["link /home"])
  s3_link0(["link /recover-password"])
  s4_link0(["email reset"])
  s5_link0(["email verify"])
  s6_link0(["email invitation"])
  s7_link1(["link /settings/seats"])
  x_people_list(["people.list"])
  s0["identity.signin<br/>/signin"]
  s0_link0 --> s0
  s0 --- s0_b0["wrong-password<br/>tests + cases + browser"]
  s0 --- s0_b1["landing<br/>tests + cases + browser"]
  s0 --- s0_b2["safe-return<br/>tests + cases"]
  s1["identity.home<br/>/home"]
  s1_link0 --> s1
  s1 --- s1_b0["redirect<br/>tests + cases + browser"]
  s2["identity.register<br/>/register"]
  s0 -- "link #quot;Start your church#quot;" --> s2
  s2 --- s2_b0["register<br/>tests + cases"]
  s3["identity.recover<br/>/recover-password"]
  s3_link0 --> s3
  s3 --- s3_b0["request-link<br/>tests + cases + browser"]
  s4["identity.reset<br/>/reset-password"]
  s4_link0 --> s4
  s4 --- s4_b0["reset<br/>tests + cases"]
  s5["identity.verify-email<br/>/verify-email"]
  s5_link0 --> s5
  s5 --- s5_b0["verify<br/>tests"]
  s6["identity.invitation<br/>/invitation"]
  s6_link0 --> s6
  s6 --- s6_b0["accept<br/>tests + cases"]
  s7["identity.seats<br/>/settings/seats"]
  x_people_list -- "menuitem #quot;Seats and invitations#quot;" --> s7
  s7_link1 --> s7
  s7 --- s7_b0["invite<br/>tests + cases + browser"]
  s7 --- s7_b1["roles-and-removal<br/>tests + cases + browser"]
```

## Surfaces

### identity.signin

Sign in with email and password, then land where the seat and a safe return address say.

- Routes: `/signin`
- Endpoints: `/api/auth/[...path]`
- Personas: visitor write, landing-finished write, landing-new write
- Catalog: IDN-001, IDN-028
- Reach:
  - link `/signin`

| State | Reach | Expect |
|---|---|---|
| form | visitor opens `/signin` | heading "Welcome back"; button "Sign in" |

#### identity.signin#wrong-password

A wrong password and an unknown address get the same answer.

- Cases: TARGET-IDN-001
- Test: `tests/integration/identity/identity.test.mts`: `AC:TARGET-IDN-001 INV-nonenumeration: sign-in refuses a wrong password and an unknown address alike, and a deleting account gets no session`
- Browser: As visitor, from state form (`/signin`):

```bash
agent-browser find label "Email" fill "nobody@example.test"
agent-browser find label "Password" fill "not-the-password-1"
agent-browser find role button click --name "Sign in" --exact
agent-browser wait --load networkidle
agent-browser find text "Email or password is incorrect." text --exact
```

#### identity.signin#landing

An Owner whose setup is finished lands on Overview; an unfinished setup or a new account lands on onboarding.

- Cases: TARGET-IDN-001
- Test: `tests/ui/identity/landing.test.mjs`: `AC:TARGET-IDN-001 (${name}): an owner whose setup is finished lands on /overview`
- Test: `tests/ui/identity/landing.test.mjs`: `AC:TARGET-IDN-001 (${name}): a new account lands on /onboarding`
- Browser: As visitor, from state form (`/signin`):

```bash
agent-browser find label "Email" fill "<invitation:/landing/finished>"
agent-browser find label "Password" fill "<invitation:/password>"
agent-browser find role button click --name "Sign in" --exact
agent-browser wait --load networkidle
agent-browser wait --url "**/overview"
```

#### identity.signin#safe-return

A safe local return address wins over the landing rule; an unsafe one is ignored and never leaves the site.

- Cases: TARGET-IDN-028, CASE-ADM-004
- Test: `tests/ui/identity/landing.test.mjs`: `AC:TARGET-IDN-028 INV-safe-return (${name}): an unsafe returnTo is ignored and never leaves the origin`
- Test: `packages/contracts/src/identity/identity.test.mts`: `AC:TARGET-IDN-028 AC:CASE-ADM-004 landingFor sends a finished seat to a safe returnTo, else its home, and setup never skips`

### identity.home

The landing address every home and post-sign-in link uses; it only redirects.

- Routes: `/home`
- Personas: visitor read, plant-owner read
- Catalog: IDN-001
- Reach:
  - link `/home`

| State | Reach | Expect |
|---|---|---|
| signed-out | visitor opens `/home` | URL `/signin?returnTo=%2Fhome` |
| plant-seat | plant-owner opens `/home` | URL `/overview` |

#### identity.home#redirect

Signed out goes to sign in with /home to come back to, without a loop.

- Cases: TARGET-IDN-001
- Test: `tests/ui/identity/landing.test.mjs`: `AC:TARGET-IDN-001 INV-session (${name}): a signed-out visitor to /home goes to /signin with /home as returnTo, without a loop`
- Browser: As visitor, from state signed-out (`/home`):

```bash
agent-browser find role heading text --name "Welcome back" --exact
```

### identity.register

Create an account to start a church, join as a sending church or network, or explore.

- Routes: `/register`
- Personas: visitor write
- Catalog: IDN-002, IDN-003
- Reach:
  - from identity.signin as visitor: click link "Start your church"

| State | Reach | Expect |
|---|---|---|
| form | visitor opens `/register` | heading "Create your account"; button "Create account" |

#### identity.register#register

Registration reveals no account or church, and a repeated registration ends in one account.

- Cases: TARGET-IDN-030
- Test: `tests/integration/identity/identity.test.mts`: `AC:TARGET-IDN-030 INV-nonenumeration: pending credentials reveal no account or tenant authority, duplicate registration converges, authenticated self resumes`

### identity.recover

Ask for a password reset link by email; the answer never says whether the address has an account.

- Routes: `/recover-password`
- Personas: visitor write
- Catalog: IDN-009
- Reach:
  - link `/recover-password`

| State | Reach | Expect |
|---|---|---|
| form | visitor opens `/recover-password` | heading "Reset your password"; button "Send reset link" |

#### identity.recover#request-link

Send reset link always answers Check your email, for a known or an unknown address.

- Cases: TARGET-IDN-009
- Test: `tests/integration/identity/identity.test.mts`: `AC:TARGET-IDN-009 INV-nonenumeration INV-identity: recovery is nonenumerating through outbox failure and unknown provider acceptance; tokens never reach security diagnostics`
- Browser: As visitor, from state form (`/recover-password`):

```bash
agent-browser find label "Email" fill "nobody@example.test"
agent-browser find role button click --name "Send reset link" --exact
agent-browser wait --load networkidle
agent-browser find role heading text --name "Check your email" --exact
```

### identity.reset

Choose a new password from the emailed link; the link works once and ends every other session.

- Routes: `/reset-password`
- Personas: visitor write
- Catalog: IDN-009
- Reach:
  - email reset link `/reset-password?token={token}` with `{token}` = `the proof in the reset email`

| State | Reach | Expect |
|---|---|---|
| no-token | visitor opens `/reset-password` | heading "This link is incomplete"; link "Ask for a new link" |

#### identity.reset#reset

A real reset consumes one proof, refuses an expired or used one and signs out every earlier session.

- Cases: TARGET-IDN-009
- Test: `tests/integration/identity/identity.test.mts`: `AC:TARGET-IDN-009 INV-proof-link: real single-use reset consumes one proof, rejects unchanged/expired/consumed proof, revokes every prior session and reports failure truthfully`

### identity.verify-email

Confirm an email address from the emailed link.

- Routes: `/verify-email`
- Personas: visitor write
- Catalog: IDN-002
- Reach:
  - email verify link `/verify-email?token={token}` with `{token}` = `the proof in the confirmation email`

| State | Reach | Expect |
|---|---|---|
| no-token | visitor opens `/verify-email` | heading "This link is incomplete" |

#### identity.verify-email#verify

Confirming the address records it with its security event and mail together.

- Test: `tests/integration/identity/identity.test.mts`: `INV-identity: interruption after credentials preserves authenticated resumption, email verification and successful reset append event and outbox together`

### identity.invitation

Accept or decline a seat or residency invitation from its emailed link, signing in or creating an account on the way.

- Routes: `/invitation`
- Endpoints: `/api/invitation`
- Personas: visitor write, plant-owner write
- Catalog: IDN-003, IDN-017
- Reach:
  - email invitation link `/invitation#proof={proof}` with `{proof}` = `the proof in the invitation email`

| State | Reach | Expect |
|---|---|---|
| no-proof | visitor opens `/invitation` | heading "This page is not available" |

#### identity.invitation#accept

Accepting activates one seat and Person even when two tabs accept at once, and never from email equality alone.

- Operations: seats.acceptInvitation
- Cases: TARGET-IDN-002, TARGET-IDN-003, TARGET-IDN-030
- Test: `tests/integration/identity/invitations.test.mts`: `AC:TARGET-IDN-002 AC:TARGET-IDN-030 AC:SCHEMA-002 INV-acceptance: concurrent same-intent claim activates one seat, Person, receipt and security intent`
- Test: `tests/integration/identity/invitations.test.mts`: `AC:TARGET-IDN-002 AC:TARGET-IDN-003 AC:TARGET-IDN-030 AC:SEC-03 native invitation signup, sign-in and exact resume never activate from email equality`

### identity.seats

Seats and invitations: who can sign in to the church, pending invitations, roles and removal.

- Routes: `/settings/seats`
- Personas: plant-owner write, plant-admin write, plant-member read
- Catalog: IDN-017, IDN-019
- Reach:
  - from people.list as plant-owner: click button "account menu", click menuitem "Seats and invitations"
  - link `/settings/seats`

| State | Reach | Expect |
|---|---|---|
| manage | plant-owner opens `/settings/seats` | heading "Seats and invitations"; button "Send invitation" |
| member | plant-member opens `/settings/seats` | heading "Seats and invitations"; no text "Send invitation" |

#### identity.seats#invite

Send invitation emails a link that works for 30 days and lists it under Waiting for an answer.

- Operations: seats.invite, seats.listInvitations
- Cases: TARGET-IDN-017, ROLE43-006
- Test: `tests/integration/identity/invitations.test.mts`: `AC:TARGET-IDN-017 AC:TARGET-IDN-003 AC:ROLE43-006 ordinary invitation hides account resolution and persists hashed expiring proof`
- Test: `tests/integration/identity/invitations.test.mts`: `AC:ROLE43-006 INV-settings-member INV-invitations: pending and Member actors cannot send or list administrative invitations`
- Browser: As plant-owner, from state manage (`/settings/seats`):

```bash
agent-browser find label "Email address" fill "map-proof@example.test"
agent-browser find role button click --name "Send invitation" --exact
agent-browser wait --load networkidle
agent-browser wait --text "Invitation sent to"
agent-browser find text "map-proof@example.test" text --exact
```

#### identity.seats#roles-and-removal

An Owner changes roles and removes a seat after handing over its open duties; the Owner seat stays.

- Operations: seats.changeOrdinaryRole, seats.appointAdmin, seats.demote, seats.remove
- Cases: TARGET-IDN-019
- Test: `tests/integration/identity/invitations.test.mts`: `AC:TARGET-IDN-019 AC:ROLE43-009 AC:ROLE43-017 roster and ordinary role changes preserve Owner and exact tenant`
- Test: `tests/integration/identity/invitations.test.mts`: `AC:TARGET-IDN-019 INV-removal: exact open-duty handoff retains Person and closed work while revoking all sessions`
- Browser: As plant-owner, from state manage (`/settings/seats`):

```bash
agent-browser find role combobox text --name "Role for"
```
