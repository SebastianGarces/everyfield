# Authentication and domain acceptance

Credentials, cookies, sessions and mailbox proofs have one supported authentication owner. Application grants remain separate. A valid credential does not itself authorize domain access. Adapter mappings and supported library settings follow [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

## Staged registration

Credential creation may succeed before domain acceptance. An `account` with pending registration can authenticate and resume, inspect or cancel its own setup, but cannot access tenant business data or Evry tools. An email address, token preview or successful credential creation does not establish a seat, Person link or organization grant.

Domain acceptance validates the addressed proof, current inviter authority, recipient, expiry/revocation, normalized intent and single-seat rule. Invitation claim, permitted seat or Discovery relationship, required same-plant Person linkage, active registration, audit and security-mail work succeed or fail together. An exact retry returns the original outcome; changed input conflicts. Concurrent revoke/accept or two-tenant acceptance has one legal winner.

Interrupted credential provisioning stays unprivileged and resumable after actual authentication or mailbox proof. Do not delete a valid existing credential as compensation for failed setup. Actual plant creation is a separate atomic operation, including Owner seat, required Person linkage, one creation-origin Phase 1 transition and reviewed document copies. Reading readiness is not a creation prerequisite.

## Sessions and account changes

Verify a live session at the server boundary and current domain grants/lifecycle for durable work. Cookie presence, a layout check or stale render cannot authorize a change. Session checks reflect revocation. Sessions expire after 30 days and renew after 15 days. Reset proofs expire after one hour. Password bounds are 8 to 1024 characters, and unchanged secrets are refused. Session storage/cache/adapter configuration follows the patterns.

Password change revokes other sessions and preserves only the supported initiating session. Password reset revokes all prior sessions. The pinned authentication adapter must prove this through real requests and live sessions; library documentation alone is not application evidence.

Record significant authentication changes and required security mail only after the supported credential call reports success. A later audit failure cannot undo committed credentials. Expose the reporting gap for restricted reconciliation. An uncertain call is never recorded as success or blindly retried with a saved password. No password, proof token or cookie enters background work. Session revocation remains authoritative even when reporting is delayed. Ordinary renewal is not a business event or PI input.

Email change, suppression restoration and deletion cancellation require fresh native identity/mailbox proof for the exact subject. Email changes follow Better Auth's supported verification and session policy; CRM email changes do not merge identities. Logout revokes only the addressed live session. Deletion immediately denies affected ordinary domain access independently of adapter cleanup; cancellation never revives old sessions.

Login and password-change limits are five failures per normalized identifier and 20 per trusted IP over 15 minutes. Reset requests have a separate three-per-identifier and ten-per-IP hourly budget. Concurrent reservations enforce the limits; success clears only the relevant own identifier/kind failures. Missing trusted IP skips that axis, and throttle rows expire within 24 hours. Public invitation and registration limits remain separately scoped. Responses do not enumerate accounts.

## Deletion and retained history

An account may request its personal deletion; a plant's current Owner alone may request workspace deletion. Last-required-Owner removal or purge blocks for separately approved manual resolution. Lead titles, platform roles and affiliations create no substitute authority.

Deletion records the exact current request and immutable 30-day cancellation deadline. Normal affected access stops immediately. Narrow native cancellation-only proof permits status/cancel strictly before the deadline without exposing private bodies or granting Evry access. Cancellation restores only independently valid grants and requires fresh sign-in. Shared plant-owned Person, training, meeting and Launch facts survive personal removal with minimal attribution; private account bodies and credentials purge. Completed live purge starts the seven-day recovery-copy horizon. [Recovery](recovery.md) defines restore denial and required lifecycle evidence.

AUTH-001 through AUTH-008 and the relevant tenancy/deletion cases remain future runtime proof. Incompatible supported mapping blocks the affected slice until repaired within Better Auth.
