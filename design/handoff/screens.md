# Screens

Every screen in the prototype, with a proposed Next.js App Router route, the work packages in [`docs/plan/dag.json`](../../docs/plan/dag.json) that build it, the states the prototype draws, and whether it needs a phone layout.

The routes are proposals. They keep the v2 path when v2 had one, so old links can redirect. Final paths belong to WP-048 (dashboard, navigation and settings integration).

Open a prototype route by adding it to the file URL, for example `everyfield-ui.html#/people`. The design dock's Preview button switches the role (Owner or Member) and the data state on the pages that draw states.

## App pages

All app pages are desktop only and sit inside the app shell (top bar, rail, content column).

| Prototype route | Screen | Proposed route | v2 path | Work packages | States drawn |
|---|---|---|---|---|---|
| `#/overview` | Overview dashboard | `/` | `/dashboard` | WP-048, WP-044 | live, first week, loading, error, no access, member |
| `#/people` | People list and pipeline (wide) | `/people` | none | WP-011, WP-012 | live, loading, error, no access, empty, member |
| `#/people/maria-santos` | Person | `/people/[personId]` | `/people/[id]/*` tabs | WP-011, WP-012, WP-014, WP-023 | live, member |
| `#/people/import` | CSV import review | `/people/import` | none | WP-013 | live |
| `#/people/duplicates` | Duplicate review and merge, and Unmerge from the person's history | `/people/duplicates` | none | WP-015 | live, Unmerge preview, Unmerge done, Unmerge refused |
| `#/meetings` | Meetings list (wide) | `/meetings` | `/meetings` | WP-020 | live |
| `#/meetings/vision-12` | Meeting | `/meetings/[meetingId]` | `/meetings/[id]` | WP-020, WP-021, WP-022 | live |
| `#/tasks` | Tasks | `/tasks` | `/tasks` | WP-024, WP-025, WP-023 | live, member |
| `#/ministries` | Ministries (teams) | `/ministries` | `/teams` | WP-016, WP-017, WP-018 | live |
| `#/ministries/worship` | Ministry | `/ministries/[teamId]` | `/teams/[teamId]` | WP-016 to WP-019 | live |
| `#/wiki` | Wiki article with Source bar | `/wiki/[...slug]` | `/wiki/[...slug]` | WP-033, WP-034 | live, named source |
| `#/wiki/edit` | Wiki editor for organization Owners and Admins | `/wiki/[...slug]/edit` | none | WP-033, WP-034, WP-035 | draft |
| `#/intelligence` | Plant Intelligence | `/intelligence` | `/phase` | WP-038, WP-044 | live |
| `#/intelligence/attestations` | Attestations: every human attestation grouped by lens, renewal states, answer dialog with history, monthly renewal pass. The same records open from Launch, Ministries, Settings and lens cards (PI-014, PI-015) | `/intelligence/attestations` | `/phase` signals | WP-039, WP-040, WP-044 | live, member |
| `#/me/check-in` | Weekly private check-in: four questions, note, 8-week history, corrections keep the earlier answer. Author only; Evry off on the page; never shown to others (PI-038, PI-040, PI-041) | `/me/check-in` | `/phase/checkins` | WP-039 | current week, correcting |
| `#/launch` | Launch plan | `/launch` | none | WP-045, WP-046 | live |
| `#/communication` | Communication | `/communication` | `/communication` | WP-027, WP-029 | live |
| `#/documents` | Documents (wide) | `/documents` | `/documents` | WP-036, WP-037 | live |
| `#/notifications` | Notifications | `/notifications` | `/notifications` | WP-030 | live |
| `#/network` | Network plants: portfolio stats, plant directory by area, status by name, no ranking | `/network` | `/oversight`, `/oversight/plants` | WP-047, WP-007 | live |
| `#/network/plant` | One plant as the network sees it: phase journey, launch, sharing categories, the plant's shared findings | `/network/plants/[plantId]` | `/oversight/plants/[id]` | WP-047, WP-044 | shared, shared but empty, not shared |
| `#/network/intelligence` | Network Intelligence: draft network rubric over shared Plant Intelligence results, by all plants, state and metro area; each lens opens the list of plants behind it | `/network/intelligence` | `/oversight/health` (partly) | WP-044, WP-047, WP-041 to WP-043; settled as PI-043 (REQ-PI-043) | live, not enough plants |
| `#/help` | Help center | `/help` | none | future feature, not in v3 scope; design kept for later | live |
| `#/help/article` | Help how-to | `/help/[slug]` | none | future feature, not in v3 scope; design kept for later | live |

A Member seat is not view-only. A Member reads what the seat allows and acts on their own duties (REQ-IDN-029). On Tasks, a Member completes or reopens a task assigned to them and adds steps under their own task, one level deep (REQ-TSK-003, REQ-TSK-005). New tasks, assigning, rescheduling, other people's tasks and broad administration stay hidden. The prototype's Member preview hides every action marked `data-edit`, shows a banner, and on Tasks shows the Member's own tasks. The prototype marks actions on Overview, People, the person page and Tasks. In the build, the server decides what each seat may do, and the UI hides actions the seat cannot use.

## Bare pages

No top bar or rail.

| Prototype route | Screen | Proposed route | Work packages |
|---|---|---|---|
| `#/signin` | Sign in, with an invitation notice | `/sign-in` | WP-005, WP-008 |
| `#/onboarding` | Onboarding, phase step | `/onboarding` | WP-009 |

## Settings

Settings is a dialog over the current page, not a page. Each section has its own link so it can be shared. In the App Router, use an intercepting route (`@modal/(.)settings/[section]`) so the link opens the dialog over the page and a fresh load still works.

| Prototype route | Section | Proposed route | Work packages |
|---|---|---|---|
| `#/settings/church` | Church profile | `/settings/church` | WP-010 |
| `#/settings/seats` | Seats and invitations | `/settings/seats` | WP-008, WP-010 |
| `#/settings/notifications` | Notifications per category and channel | `/settings/notifications` | WP-030 |
| `#/settings/sharing` | Sharing and privacy for organizations | `/settings/sharing` | WP-007 |
| `#/settings/account` | Your account | `/settings/account` | WP-005, WP-010 |

Closing Settings returns to the page underneath. Unsaved changes ask before they are discarded.

## Overlays

These open over any page and have no route of their own.

| Overlay | Opens from | Work packages | Notes |
|---|---|---|---|
| Evry panel (chat, review cards, history) | Ask Evry, ⌘J | WP-051 to WP-053 | Every durable change needs review and approval (EVR-012, REQ-EVR-012). |
| Guide panel | Guide in the rail | WP-034 | Shows the Wiki article for the page (WIKI-008). The help center links in the panel are a future feature; leave them out in v3. |
| Feedback dialog | Send feedback in the rail | WP-049 | Keep the design as drawn: text and page details only, no screenshot. The feedback feature (ADM-001) is changed to match it. |
| Notification drop-down | Bell in the top bar | WP-030 | |
| User menu | Name in the top bar | WP-010, WP-047 | Switches between the church and the network. |
| Wiki source menu | Source bar on a Wiki article | WP-034 | Changes only what the reader sees now (WIKI-001, REQ-KNOW-191). |
| Publish review, Hide dialog | Wiki editor | WP-034, WP-035 | Lists changed sections. A side-by-side comparison is not approved. |

## Phone screens

The main app is desktop only. These screens need a phone layout because people use them on a phone or open them from an email. They are on the prototype's `#/mobile` page.

| Screen | Opened from | Proposed route | Sign-in | Work packages |
|---|---|---|---|---|
| Door check-in | Meeting page, Start check-in | `/meetings/[meetingId]/check-in` | yes | WP-022 |
| Public RSVP | Meeting invitation email | `/rsvp/[token]` (same as v2) | no, token link | WP-021 |
| Follow-up call | Tasks or a notification | `/follow-ups/[taskId]` | yes | WP-023 |
| Accept a seat invitation | Seat invitation email | `/invite/[token]` | creates an account | WP-008 |
| RSVP confirmed, change answer | RSVP confirmation email | `/rsvp/[token]` | no, token link | WP-021 |
| Email preferences | Footer of every church email | `/email-preferences/[token]` (v2 used `/unsubscribe`) | no, token link | WP-030, WP-028 |

Token links are personal and expire. They show only that person's own data.

## Emails

The prototype's `#/emails` page shows each email at 600px and 375px. Build them with an email renderer such as React Email, using fixed light colors and the 600px column. Email clients often drop web fonts, so each font stack needs system fallbacks.

| Email | From | Main link | Work packages |
|---|---|---|---|
| Seat invitation | Everyfield | Accept a seat invitation | WP-008 |
| Meeting invitation | the church | Public RSVP (Yes, Maybe, No buttons) | WP-021, WP-027 |
| Church announcement | the church | the link the author adds | WP-027, WP-028 |
| Notification, such as follow-ups overdue | Everyfield | the app | WP-030 |
| Weekly digest | Everyfield | the app | WP-030 |
| RSVP confirmation | the church | RSVP confirmed, change answer | WP-021 |

Every church email footer has the church address, an Email preferences link and an Unsubscribe link.

## Screen-to-feature map

Each prototype screen or flow and the features it serves. Feature IDs are in [`docs/catalog/features.json`](../../docs/catalog/features.json). "Designed" means the prototype draws it. Behavior still comes from the requirements.

| Prototype screen or flow | Features | Status |
|---|---|---|
| Sign in (`#/signin`) | IDN-001, IDN-017 | designed |
| Onboarding (`#/onboarding`) | IDN-013, IDN-014, IDN-015, PHASE-001 | designed |
| Overview dashboard (`#/overview`) | ADM-004, ADM-005, PI-025, PI-027, LCH-008 | designed |
| People list and pipeline (`#/people`) | PPL-001, PPL-006, PPL-007, PPL-010, PPL-019 | designed |
| Person (`#/people/maria-santos`) | PPL-002, PPL-004, PPL-005, PPL-008, PPL-009, PPL-011 to PPL-014, PPL-021 | designed |
| CSV import review (`#/people/import`) | PPL-018 | designed |
| Duplicate review, merge and Unmerge (`#/people/duplicates`) | PPL-016, PPL-017 | designed |
| Meetings and meeting (`#/meetings`, `#/meetings/vision-12`) | MTG-001 to MTG-007, MTG-012 to MTG-014, MTG-016 | designed |
| Tasks, including Member own tasks (`#/tasks`) | TSK-001, TSK-003, TSK-005, TSK-008, TSK-009 | designed |
| Ministries and ministry (`#/ministries`, `#/ministries/worship`) | TEAM-001, TEAM-004 to TEAM-008, TEAM-011 | designed |
| Wiki article, source bar and editor (`#/wiki`, `#/wiki/edit`) | WIKI-001 to WIKI-007 | designed |
| Plant Intelligence (`#/intelligence`) | PI-014, PI-023 to PI-029, PI-033, PHASE-004 | designed |
| Attestations (`#/intelligence/attestations`) | PI-014, PI-015 | designed |
| Weekly private check-in (`#/me/check-in`) | PI-038 to PI-041 | designed |
| Launch plan (`#/launch`) | LCH-001 to LCH-008 | designed |
| Communication (`#/communication`) | COM-001 to COM-004, COM-007 | designed |
| Documents (`#/documents`) | DOC-001 to DOC-003 | designed |
| Notifications page, bell and settings section | NTF-003, NTF-004, IDN-012 | designed |
| Network plants and one plant (`#/network`, `#/network/plant`) | IDN-022, IDN-023, PI-031 | designed |
| Network Intelligence (`#/network/intelligence`) | PI-043, PI-044 | designed |
| Settings dialog: church, seats, sharing, account | IDN-010, IDN-011, IDN-017, IDN-019, IDN-022, IDN-006 to IDN-008 | designed |
| Evry panel | EVR-005, EVR-010, EVR-012 | designed |
| Guide panel | WIKI-008 | designed |
| Feedback dialog | ADM-001 | designed |
| Phone: door check-in, RSVP, follow-up call, invitation, email preferences | MTG-009, MTG-010, REQ-MTG-022, IDN-017, NTF-012 | designed |
| Emails | IDN-017, MTG-018, COM-005, NTF-007, NTF-013 | designed |
| Help center and how-to (`#/help`, `#/help/article`) | none in v3 | future feature, design kept for later |

### Flows not drawn

These flows have requirements but no drawing. Do not wait for a drawing. The owning UI package composes each one from existing components and patterns.

| Flow | Features and requirements | Owning packages | Status |
|---|---|---|---|
| Registration, resume and cancel | IDN-002, IDN-003, IDN-015 (REQ-IDN-015) | WP-005, WP-008, WP-009 | not designed |
| Password recovery | IDN-009 | WP-005 | not designed |
| Personal account deletion and its cancellation | IDN-026 (REQ-IDN-032) | WP-007, WP-010 | not designed |
| Church workspace deletion by the Owner and its cancellation | IDN-026 (REQ-IDN-032) | WP-007, WP-010 | not designed |
| Personal timezone for the private check-in | IDN-010, IDN-011 (REQ-IDN-033) | WP-010, WP-039 | not designed |
| Native document writing and Word import | DOC-016 | WP-036, WP-037, WP-079, WP-080 | not designed |
| Your own feedback and its status | ADM-001, ADM-002 (REQ-KNOW-029) | WP-049 | not designed |
| Discovery without a plant | IDN-016, ADM-004 (REQ-ADM-004) | WP-007, WP-009, WP-048 | not designed |
| Wiki source order in Settings | WIKI-001 (REQ-KNOW-191) | WP-034, WP-035 | not designed; see the [README](README.md#not-designed-yet) |

## Design system pages

These exist only in the prototype and are not app routes.

| Prototype route | Content |
|---|---|
| `#/foundations` | tokens, color, gradients, type, shape, content width |
| `#/components` | every component and its states, the Evry character |
| `#/inventory` | the component table that [components.md](components.md) is generated from |
| `#/mobile` | the phone screens above |
| `#/emails` | the emails above |
