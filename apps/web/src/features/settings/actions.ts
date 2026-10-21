"use server";

import * as S from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import type { z } from "zod";
import type {
	AvatarResult,
	AvatarUpload,
	CredentialOutcome,
	DeletionStatus,
	GetSectionRequest,
	PersonalTimezonePreview,
	PersonalTimezoneResult,
	PlantTimezonePreview,
	PlantTimezoneResult,
	Reply,
	SavedSection,
	SaveChurchRequest,
	SaveSectionRequest,
	SectionResult,
} from "./port";
import {
	cancelRestrictedDeletion,
	credential,
	openRestrictedDeletion,
	readSection,
	restrictedStatus,
	run,
} from "./server";

// The settings server actions: one per operation the product screens use. Each parses the browser's request with the
// settings contract (server.ts run), so a field the contract refuses never reaches the database, and the owner comes
// from the session, never from the browser.

export async function getSection(request: GetSectionRequest): Promise<Reply<SectionResult>> {
	return readSection(request);
}

export async function saveSection(request: SaveSectionRequest): Promise<Reply<SavedSection>> {
	return run(
		S.saveSectionRequest,
		request,
		(r) => r.input.section,
		(ops, tx, context, r) => ops.sections.saveSection(tx, context, r),
	);
}

/** One church form submission: up to three changes in one write, with one audit row and one request key. */
export async function saveChurch(request: SaveChurchRequest): Promise<Reply<SavedSection>> {
	return run(
		S.saveChurchRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.sections.saveChurch(tx, context, r),
	);
}

/** A preview stores what it shows, so it runs as a write. */
export async function previewPlantTimezone(
	request: z.input<typeof S.previewPlantTimezoneRequest>,
): Promise<Reply<PlantTimezonePreview>> {
	return run(
		S.previewPlantTimezoneRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.timezones.previewPlantTimezone(tx, context, r),
	);
}

export async function setPlantTimezone(
	request: z.input<typeof S.setPlantTimezoneRequest>,
): Promise<Reply<PlantTimezoneResult>> {
	return run(
		S.setPlantTimezoneRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.timezones.setPlantTimezone(tx, context, r),
	);
}

// Your account's photo (REQ-IDN-006). The bytes go to the authenticated version route
// (/api/accounts/<account>/avatar/<upload>) between the two calls.

/** Stages one upload: the server owns its id, type and size. The bytes follow with PUT to the version route. */
export async function requestAvatarUpload(
	request: z.input<typeof S.requestAvatarUpload>,
): Promise<Reply<AvatarUpload>> {
	return run(
		S.requestAvatarUpload,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.requestAvatarUpload(tx, context, r),
	);
}

export async function finalizeAvatar(request: z.input<typeof S.finalizeAvatarRequest>): Promise<Reply<AvatarResult>> {
	return run(
		S.finalizeAvatarRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.finalizeAvatar(tx, context, r),
	);
}

export async function removeAvatar(request: z.input<typeof S.removeAvatarRequest>): Promise<Reply<AvatarResult>> {
	return run(
		S.removeAvatarRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.avatar.removeAvatar(tx, context, r),
	);
}

// Sign-in email and password (REQ-IDN-007, REQ-IDN-008): Better Auth makes the change.

export async function requestEmailChange(
	request: z.input<typeof N.requestEmailChange>,
): Promise<Reply<{ status: "verification_requested" }>> {
	return credential(N.requestEmailChange, request, (ops, context, r) => ops.requestEmailChange(context, r));
}

export async function confirmEmailChange(request: z.input<typeof N.confirmEmailChange>): Promise<CredentialOutcome> {
	return outcome(
		await credential(N.confirmEmailChange, request, (ops, context, r) => ops.confirmEmailChange(context, r)),
	);
}

export async function changePassword(request: z.input<typeof N.changePasswordRequest>): Promise<CredentialOutcome> {
	return outcome(
		await credential(N.changePasswordRequest, request, (ops, context, r) => ops.changePassword(context, r)),
	);
}

/** A credential call the mount refused before Better Auth ran reads as refused, never as success. */
function outcome(
	reply: CredentialOutcome | { status: "refused"; error: { correlationId: string } },
): CredentialOutcome {
	return "error" in reply
		? N.credentialOutcome.parse({ status: "refused", correlationId: reply.error.correlationId })
		: reply;
}

// Your own time zone (REQ-IDN-033): a preview stores what it shows, then the save binds to it.

export async function previewPersonalTimezone(
	request: z.input<typeof N.previewPersonalTimezoneRequest>,
): Promise<Reply<PersonalTimezonePreview>> {
	return run(
		N.previewPersonalTimezoneRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.timezones.previewPersonalTimezone(tx, context, r),
	);
}

export async function setPersonalTimezone(
	request: z.input<typeof N.setPersonalTimezoneRequest>,
): Promise<Reply<PersonalTimezoneResult>> {
	return run(
		N.setPersonalTimezoneRequest,
		request,
		() => "account",
		(ops, tx, context, r) => ops.timezones.setPersonalTimezone(tx, context, r),
	);
}

// Deleting your own login (REQ-IDN-032). The request ends every session; the restricted page then shows the
// request and can cancel it before the deadline.

export async function requestAccountDeletion(
	request: z.input<typeof S.requestAccountDeletion>,
): Promise<Reply<DeletionStatus>> {
	return run(
		S.requestAccountDeletion,
		request,
		() => "account",
		(ops, tx, context, r) => ops.deletion.requestAccountDeletion(tx, context, r),
	);
}

/** Fresh proof on the restricted page: the original login and its current password. */
export async function openAccountDeletion(
	request: z.input<typeof N.openAccountDeletionRequest>,
): Promise<Reply<DeletionStatus>> {
	return openRestrictedDeletion(request);
}

export async function getAccountDeletionStatus(): Promise<Reply<DeletionStatus>> {
	return restrictedStatus();
}

export async function cancelAccountDeletion(expectedRevision: string): Promise<Reply<DeletionStatus>> {
	return cancelRestrictedDeletion(expectedRevision);
}
