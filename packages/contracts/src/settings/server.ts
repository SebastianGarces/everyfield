import type { z } from "zod";
import type { Owner, sessionId, Reply } from "../common/values.ts";
import type { changePasswordRequest } from "../identity/requests.ts";
import type { credentialOutcome } from "../identity/results.ts";
import type * as native from "./native.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";

export type SettingsContext = { session: z.infer<typeof sessionId>; selected: Owner };
export type SettingsReply<T> = Reply<T, result.SettingsError>;
type Operation<Tx, Context, Input extends z.ZodType, Output extends z.ZodType> = (
	tx: Tx,
	context: Context,
	input: z.infer<Input>,
) => Promise<SettingsReply<z.infer<Output>>>;

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

export interface PersonalTimezoneCalendar<Tx> {
	preview(tx: Tx, input: { account: string; previewId: string }): Promise<void>;
	apply(tx: Tx, input: { account: string; previewId: string; zone: string; at: string }): Promise<boolean>;
}
