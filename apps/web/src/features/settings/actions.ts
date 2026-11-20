"use server";

import * as S from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import { drainObjectCleanup } from "@/server/jobs/drain-object-cleanup";
import type {
	AvatarResult,
	AvatarUpload,
	CredentialOutcome,
	DeletionStatus,
	PersonalTimezonePreview,
	PersonalTimezoneResult,
	PlantTimezonePreview,
	PlantTimezoneResult,
	Reply,
	SavedSection,
} from "./port";
import { cancelRestrictedDeletion, credential, openRestrictedDeletion, restrictedStatus, run } from "./server";

export async function saveSection(request: unknown): Promise<Reply<SavedSection>> {
	return run(
		S.saveSectionRequest,
		request,
		(r) => r.input.section,
		(ops, tx, context, r) => ops.sections.saveSection(tx, context, r),
	);
}

export async function saveChurch(request: unknown): Promise<Reply<SavedSection>> {
	return run(
		S.saveChurchRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.sections.saveChurch(tx, context, r),
	);
}

export async function previewPlantTimezone(request: unknown): Promise<Reply<PlantTimezonePreview>> {
	return run(
		S.previewPlantTimezoneRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.timezones.previewPlantTimezone(tx, context, r),
	);
}

export async function setPlantTimezone(request: unknown): Promise<Reply<PlantTimezoneResult>> {
	return run(
		S.setPlantTimezoneRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.timezones.setPlantTimezone(tx, context, r),
	);
}

export async function requestAvatarUpload(request: unknown): Promise<Reply<AvatarUpload>> {
	return run(
		S.requestAvatarUpload,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.requestAvatarUpload(tx, context, r),
	);
}

export async function finalizeAvatar(request: unknown): Promise<Reply<AvatarResult>> {
	drainObjectCleanup();
	return run(
		S.finalizeAvatarRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.finalizeAvatar(tx, context, r),
	);
}

export async function removeAvatar(request: unknown): Promise<Reply<AvatarResult>> {
	drainObjectCleanup();
	return run(
		S.removeAvatarRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.removeAvatar(tx, context, r),
	);
}

export async function requestEmailChange(request: unknown): Promise<Reply<{ status: "verification_requested" }>> {
	return credential(N.requestEmailChange, request, (ops, context, r) => ops.requestEmailChange(context, r));
}

export async function confirmEmailChange(request: unknown): Promise<CredentialOutcome> {
	return outcome(
		await credential(N.confirmEmailChange, request, (ops, context, r) => ops.confirmEmailChange(context, r)),
	);
}

export async function changePassword(request: unknown): Promise<CredentialOutcome> {
	return outcome(
		await credential(N.changePasswordRequest, request, (ops, context, r) => ops.changePassword(context, r)),
	);
}

function outcome(
	reply: CredentialOutcome | { status: "refused"; error: { correlationId: string } },
): CredentialOutcome {
	return "error" in reply
		? N.credentialOutcome.parse({ status: "refused", correlationId: reply.error.correlationId })
		: reply;
}

export async function previewPersonalTimezone(request: unknown): Promise<Reply<PersonalTimezonePreview>> {
	return run(
		N.previewPersonalTimezoneRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.timezones.previewPersonalTimezone(tx, context, r),
	);
}

export async function setPersonalTimezone(request: unknown): Promise<Reply<PersonalTimezoneResult>> {
	return run(
		N.setPersonalTimezoneRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.timezones.setPersonalTimezone(tx, context, r),
	);
}

export async function requestAccountDeletion(request: unknown): Promise<Reply<DeletionStatus>> {
	return run(
		S.requestAccountDeletion,
		request,
		() => "account",
		(ops, tx, context, r) => ops.deletion.requestAccountDeletion(tx, context, r),
	);
}

export async function openAccountDeletion(request: unknown): Promise<Reply<DeletionStatus>> {
	return openRestrictedDeletion("account", request);
}

export async function getAccountDeletionStatus(): Promise<Reply<DeletionStatus>> {
	return restrictedStatus("account");
}

export async function cancelAccountDeletion(expectedRevision: string): Promise<Reply<DeletionStatus>> {
	return cancelRestrictedDeletion("account", expectedRevision);
}

export async function requestWorkspaceDeletion(request: unknown): Promise<Reply<DeletionStatus>> {
	return run(
		S.requestWorkspaceDeletion,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.deletion.requestWorkspaceDeletion(tx, context, r),
	);
}

export async function openWorkspaceDeletion(request: unknown): Promise<Reply<DeletionStatus>> {
	return openRestrictedDeletion("plant", request);
}

export async function getWorkspaceDeletionStatus(): Promise<Reply<DeletionStatus>> {
	return restrictedStatus("plant");
}

export async function cancelWorkspaceDeletion(expectedRevision: string): Promise<Reply<DeletionStatus>> {
	return cancelRestrictedDeletion("plant", expectedRevision);
}
