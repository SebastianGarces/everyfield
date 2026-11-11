import type { z } from "zod";
import type { Owner, sessionId } from "../common/values.ts";
import type { changePasswordRequest } from "../identity/requests.ts";
import type { credentialOutcome } from "../identity/results.ts";
import type * as native from "./native.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";

export type SettingsContext = { session: z.infer<typeof sessionId>; selected: Owner };
export type SettingsReply<T> = { status: "ok"; value: T } | { status: "refused"; error: result.SettingsError };
type Operation<Tx, Context, Input extends z.ZodType, Output extends z.ZodType> = (
	tx: Tx,
	context: Context,
	input: z.infer<Input>,
) => Promise<SettingsReply<z.infer<Output>>>;

// Freshly reload active account, session, exact section owner, seat, subject
// lifecycle, revision and current policy on every invocation, before replay.
// Cache keys include exact actor+tenant+purpose and current authority witnesses.
// Account/notifications remain self service for Member/Discovery/org accounts.
// Plant/team routine edits require actual same-plant Owner/Admin and real parent;
// organization profile requires exact typed org Owner/Admin. CRM titles confer
// nothing. Affiliation writes delegate to WP-007 in the SAME Tx with relationship
// and consent CAS, one history/audit/receipt/intents set, omitted fields preserved.
// No-op/replay does not bump material revision; private care never enters settings.
export interface SettingsProducer<Tx> {
	saveSection: Operation<Tx, SettingsContext, typeof request.saveSectionRequest, typeof result.savedSectionResult>;
	saveChurch: Operation<Tx, SettingsContext, typeof request.saveChurchRequest, typeof result.savedSectionResult>;
	updatePlantProfile: Operation<
		Tx,
		SettingsContext,
		typeof request.updatePlantProfileRequest,
		typeof result.savedSectionResult
	>;
	setDigestSchedule: Operation<
		Tx,
		SettingsContext,
		typeof request.setDigestScheduleRequest,
		typeof result.savedSectionResult
	>;
	previewPlantTimezone: Operation<
		Tx,
		SettingsContext,
		typeof request.previewPlantTimezoneRequest,
		typeof result.plantTimezonePreview
	>;
	setPlantTimezone: Operation<
		Tx,
		SettingsContext,
		typeof request.setPlantTimezoneRequest,
		typeof result.plantTimezoneResult
	>;
}
// Native operations use authenticated self, never submitted account/session/IP.
// Avatar: verify bytes/type and generated private staging ownership; atomically
// save version/reference/audit then enqueue old unreferenced cleanup. Failed row
// save retains old reference and enqueues orphan cleanup; failed cleanup leaves
// the new reference usable. Remove reference before cleanup. No bearer delivery.
// Credentials: WP-005 Better Auth owns proof/session policy and unique email.
// Email proof lasts 24h, must be live and owned by authenticated requester. Budget
// requests/failures by own normalized login 3/hour + trusted IP 10/hour, regardless
// of target. Password failure budget 5/own login +20/IP per 15m. Prove current secret
// before unchanged-secret refusal; revokeOtherSessions=true preserves only the
// eligible initiating session. Never persist/retry passwords or tokens. Supported
// auth call precedes truthful app event+security mail intent. Unknown/refused has
// no success event; reporting failure cannot roll back credentials/revocation.
export interface NativeAccountProducer<Tx> {
	requestAvatarUpload: Operation<
		Tx,
		SettingsContext,
		typeof request.requestAvatarUpload,
		typeof result.avatarUploadResult
	>;
	finalizeAvatar: Operation<Tx, SettingsContext, typeof request.finalizeAvatarRequest, typeof result.avatarResult>;
	removeAvatar: Operation<Tx, SettingsContext, typeof request.removeAvatarRequest, typeof result.avatarResult>;
	getAvatar: Operation<Tx, SettingsContext, typeof request.getAvatarRequest, typeof result.avatarResult>;
	previewPersonalTimezone: Operation<
		Tx,
		SettingsContext,
		typeof native.previewPersonalTimezoneRequest,
		typeof native.personalTimezonePreview
	>;
	setPersonalTimezone: Operation<
		Tx,
		SettingsContext,
		typeof native.setPersonalTimezoneRequest,
		typeof native.personalTimezoneResult
	>;
}
// Account preference CAS + required replan intent commit together. WP-039 joins
// that transaction for current same-plant Owner/Admin original authors, serializes
// against author calendar revision and binds its separately reviewed exact future
// Monday transition, preserving open stable week/history. Ineligible actors expose
// no calendar-existence flag. No private metadata/PI effects/shared audit payload.
// Plant timezone saves bind unexpired preview to exact subject/revision/zone and
// current future sources. Preserve LocalDates, past/one-time appointment Instants;
// replan only future owed logical slots, never delivered slots. Bounded preview
// pagination does not authorize a partial replan.

// Request suspends affected normal access/sessions/signed issuance/dispatch in
// the same transaction as the exact lifecycle witness. Personal is self-only;
// workspace request is actual current Owner-only. Continuing workspace Owner uses
// manual exception. Retain by real ownership, never creatorId; scrub/rebind shared
// church facts minimally, purge account avatar/files/private-author stream later.
// Restricted fresh proof binds original account or requesting CURRENT Owner to
// exact request; status/cancel only. Cancel strictly now<deadline under same row
// lock/CAS as purge; retry/old request never cancels another. Restore only currently
// valid independent grants with new sessions. Workers keep partial purge hidden,
// set livePurgedAt only after coherent DB+bytes completion and expire all recovery
// copies within 7 days without resetting horizon. Restore applies current witnesses
// before access; uncertainty denies. No guaranteed physical erasure at day 37.
export interface DeletionProducer<Tx> {
	requestAccountDeletion: Operation<
		Tx,
		SettingsContext,
		typeof request.requestAccountDeletion,
		typeof native.deletionStatus
	>;
	requestWorkspaceDeletion: Operation<
		Tx,
		SettingsContext,
		typeof request.requestWorkspaceDeletion,
		typeof native.deletionStatus
	>;
	getAccountDeletionStatus: Operation<
		Tx,
		native.RestrictedDeletionContext,
		typeof native.getAccountDeletionStatusRequest,
		typeof native.deletionStatus
	>;
	cancelAccountDeletion: Operation<
		Tx,
		native.RestrictedDeletionContext,
		typeof native.cancelAccountDeletionRequest,
		typeof native.deletionStatus
	>;
	getWorkspaceDeletionStatus: Operation<
		Tx,
		native.RestrictedDeletionContext,
		typeof native.getWorkspaceDeletionStatusRequest,
		typeof native.deletionStatus
	>;
	cancelWorkspaceDeletion: Operation<
		Tx,
		native.RestrictedDeletionContext,
		typeof native.cancelWorkspaceDeletionRequest,
		typeof native.deletionStatus
	>;
}

// Better Auth changes its own tables on its own client, so these calls take no app transaction: each opens the
// short transactions it needs, and no app lock is held while Better Auth runs.
export interface CredentialProducer {
	requestEmailChange(
		context: SettingsContext,
		input: z.infer<typeof native.requestEmailChange>,
	): Promise<SettingsReply<{ status: "verification_requested" }>>;
	confirmEmailChange(
		context: SettingsContext,
		input: z.infer<typeof native.confirmEmailChange>,
	): Promise<z.infer<typeof credentialOutcome>>;
	changePassword(
		context: SettingsContext,
		input: z.infer<typeof changePasswordRequest>,
	): Promise<z.infer<typeof credentialOutcome>>;
}

// WP-039 supplies this server-only collaborator (packages/domain/src/intelligence/care.ts). The account producer
// invokes it only for a current Owner or Admin author and never for anyone else. Preview binds each of the author's
// private calendars to the preview at its current revision; the binding stays in private storage, never in the
// settings preview. Apply runs in the account transaction: it keeps every open week and starts the next week at the
// first Monday strictly after `at` in the new zone. It answers false, having changed nothing, when a save or another
// change moved a calendar since the preview; Settings then refuses the whole change.
export interface PersonalTimezoneCalendar<Tx> {
	preview(tx: Tx, input: { account: string; previewId: string }): Promise<void>;
	apply(tx: Tx, input: { account: string; previewId: string; zone: string; at: string }): Promise<boolean>;
}
