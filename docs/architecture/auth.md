# Authentication and domain acceptance

Better Auth alone owns credentials, cookies, sessions and mailbox proofs. Application grants are separate. Use supported field mapping for `auth_user`, `auth_account`, `auth_session` and `auth_verification`; `account` owns application registration state. There is no custom credential-generation fence or second credential owner.

## Staged registration

Credential creation may succeed before domain acceptance. An `account` with pending registration can authenticate and resume, inspect or cancel its own setup, but cannot access tenant business data or Evry tools. An email address, token preview or successful credential creation does not establish a seat, Person link or organization grant.

Domain acceptance atomically validates the addressed invitation/proof, current inviter authority, recipient, token expiry/revocation, normalized intent and single-seat rule. It claims the token, creates the permitted seat or Discovery relationship, establishes required same-plant Person linkage, activates registration and writes `operation`, `event` and security-mail intent. A failed required write rolls back all domain consequences. An exact retry returns the original receipt; changed input conflicts. A concurrent revoke/accept or two-tenant acceptance has one legal winner.

Interrupted credential provisioning stays unprivileged and resumable after actual authentication or mailbox proof. Do not delete a valid existing credential as compensation for failed setup. Actual plant creation is a separate atomic operation, including Owner seat, required Person linkage, one creation-origin Phase 1 transition and reviewed document copies. Reading readiness is not a creation prerequisite.

## Sessions and account changes

Verify Better Auth's live database session at the server boundary, then recheck current domain grants and lifecycle for durable work. Cookie presence, a layout check or stale render cannot authorize a change. Use PostgreSQL database sessions, enabled adapter transactions, no secondary session store and disabled cookie cache. Sessions expire after 30 days and renew after 15 days. Reset proofs expire after one hour. Password bounds are 8 to 1024 characters, and unchanged secrets are refused.

Use Better Auth's built-in revocation. Password change enables revokeOtherSessions and preserves only the supported initiating session. Password reset enables revokeSessionsOnPasswordReset and revokes all prior sessions. The [password documentation](https://better-auth.com/docs/authentication/email-password) and [options reference](https://better-auth.com/docs/reference/options) describe these controls. The pinned adapter must prove the configured behavior through real requests and database sessions; library documentation is not application evidence.

Append the app's security `event` after the supported call reports success, and create required security-mail intent then. A failed event write does not undo a committed password change. Record an observable reporting failure for restricted investigation; an uncertain call is never recorded as success or blindly retried with a saved password. No password, proof token or cookie enters asynchronous job payloads. Built-in session revocation remains authoritative even when app outcome recording is delayed. Ordinary session renewal is not a business event or PI input.

Email change, suppression restoration and deletion cancellation require fresh native identity/mailbox proof for the exact subject. Email changes follow Better Auth's supported verification and session policy; CRM email changes do not merge identities. Logout revokes only the addressed live session. Deletion immediately denies affected ordinary domain access independently of adapter cleanup; cancellation never revives old sessions.

Login and password-change limits are five failures per normalized identifier and 20 per trusted IP over 15 minutes. Reset requests have a separate three-per-identifier and ten-per-IP hourly budget. Concurrent reservations enforce the limits; success clears only the relevant own identifier/kind failures. Missing trusted IP skips that axis, and throttle rows expire within 24 hours. Public invitation and registration limits remain separately scoped. Responses do not enumerate accounts.

## Deletion and retained history

An account may request its personal deletion; a plant's current Owner alone may request workspace deletion. Last-required-Owner removal or purge blocks for separately approved manual resolution. Lead titles, platform roles and affiliations create no substitute authority.

`lifecycle_witness` records the exact request, revision and immutable 30-day cancellation deadline. Normal affected access stops immediately. Narrow native cancellation-only proof allows status/cancel strictly before the deadline, without exposing private bodies or granting Evry access. Cancellation restores only independently valid grants and requires fresh normal sign-in. Shared plant-owned Person, training, meeting and Launch facts survive personal removal with minimal attribution; private account bodies and credentials purge. Completed live purge starts the seven-day recovery-copy horizon. [Recovery](recovery.md) defines restore denial and witness states.

AUTH-001 through AUTH-008 and the relevant tenancy/deletion cases remain future runtime proof. Incompatible supported mapping blocks the affected slice until repaired within Better Auth.
