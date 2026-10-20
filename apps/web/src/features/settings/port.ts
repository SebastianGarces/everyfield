import type * as S from "@everyfield/contracts/settings";
import type * as N from "@everyfield/contracts/settings/native";
import type { z } from "zod";

// The door from the settings screens to the server. Every type comes from the settings contract in
// packages/contracts/src/settings, so the screens cannot send a field the contract refuses. Production passes the
// server actions (actions.ts); the design preview passes a fixture port whose replies the same schemas parse
// (preview/fixtures.ts).

export type SettingsError = S.SettingsError;
export type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: SettingsError };

export type SectionResult = z.infer<typeof S.sectionResult>;
export type SavedSection = z.infer<typeof S.savedSectionResult>;
export type SaveSectionRequest = z.input<typeof S.saveSectionRequest>;
export type SaveChurchRequest = z.input<typeof S.saveChurchRequest>;
export type GetSectionRequest = z.input<typeof S.getSectionRequest>;
/** The section read the server started with the page at that section's address. */
export type SectionSeed = { request: GetSectionRequest; value: Promise<Reply<SectionResult>> };
/** The exact plant or organization a section belongs to, as the requests take it. */
export type PlantOwner = { kind: "plant"; id: string };
export type OrganizationOwner = {
	kind: "organization";
	id: string;
	organizationKind: "sending_church" | "sending_network";
};
export type PlantSettings = z.infer<typeof S.plantSettings>;
export type PlantProfile = z.infer<typeof S.plantProfile>;
export type Inactivity = z.infer<typeof S.inactivity>;
export type DigestSchedule = z.infer<typeof S.digestSchedule>;
export type NotificationSettings = z.infer<typeof S.notificationSettings>;
export type NotificationChoice = z.infer<typeof S.notificationChoice>;
export type NotificationPatch = z.input<typeof S.notificationPatch>;
export type AffiliationPatch = z.input<typeof S.affiliationPatch>;
export type AvatarResult = z.infer<typeof S.avatarResult>;
export type AvatarReference = z.infer<typeof S.avatarReference>;
export type AvatarUpload = z.infer<typeof S.avatarUploadResult>;
export type AvatarMime = z.infer<typeof S.avatarMime>;
export type PlantTimezonePreview = z.infer<typeof S.plantTimezonePreview>;
export type PlantTimezoneResult = z.infer<typeof S.plantTimezoneResult>;
export type TimezonePreference = z.infer<typeof S.timezonePreference>;
export type PersonalTimezonePreview = z.infer<typeof N.personalTimezonePreview>;
export type PersonalTimezoneResult = z.infer<typeof N.personalTimezoneResult>;
export type DeletionStatus = N.DeletionStatus;
export type CredentialOutcome = z.infer<typeof N.credentialOutcome>;
export type ChangePasswordRequest = z.input<typeof N.changePasswordRequest>;

/** A section the dialog can show. Seats come from WP-008/ui through the same frame. */
export type SectionKey = "church" | "organization" | "seats" | "notifications" | "sharing" | "account";

/**
 * Who is looking and in which context. The server decides authority again on every call; this only chooses which
 * sections to offer. `role` is the seat in the selected plant or organization; an account without a seat has only
 * its own sections.
 */
export type SettingsViewer =
	| { context: "plant"; accountId: string; plant: PlantOwner; role: "owner" | "admin" | "member" }
	| { context: "organization"; accountId: string; organization: OrganizationOwner; role: "owner" | "admin" | "member" }
	| { context: "account"; accountId: string };

/** One current plant/organization relationship, as WP-007 lists it; `revision` is the relationship revision. */
export type Relationship = {
	relationshipId: string;
	revision: string;
	organization: OrganizationOwner;
	organizationName: string;
};

/** The section operations. Production passes the settings server actions. */
export interface SettingsPort {
	getSection(request: GetSectionRequest): Promise<Reply<SectionResult>>;
	saveSection(request: SaveSectionRequest): Promise<Reply<SavedSection>>;
	/** Up to three church changes saved as one write; a refusal keeps all of them unsaved. */
	saveChurch(request: SaveChurchRequest): Promise<Reply<SavedSection>>;
	previewPlantTimezone(request: z.input<typeof S.previewPlantTimezoneRequest>): Promise<Reply<PlantTimezonePreview>>;
	setPlantTimezone(request: z.input<typeof S.setPlantTimezoneRequest>): Promise<Reply<PlantTimezoneResult>>;
	/**
	 * The photo, email, password, own time zone and deletion flows. They have no production server yet (storage, mail
	 * delivery, the personal calendar and deletion workers), so only the design preview supplies them and the
	 * sections show these rows only when they are present.
	 */
	flows?: FlowPort;
}

export interface FlowPort {
	requestAvatarUpload(request: z.input<typeof S.requestAvatarUpload>): Promise<Reply<AvatarUpload>>;
	/** Sends the bytes to the server-owned staging upload. The server verifies type and size again. */
	uploadAvatarBytes(uploadId: string, file: Blob): Promise<Reply<null>>;
	finalizeAvatar(request: z.input<typeof S.finalizeAvatarRequest>): Promise<Reply<AvatarResult>>;
	removeAvatar(request: z.input<typeof S.removeAvatarRequest>): Promise<Reply<AvatarResult>>;
	/** The authenticated delivery route for one avatar version (avatarRoute). Never a storage key or bearer URL. */
	avatarSrc(avatar: AvatarReference): string;

	requestEmailChange(
		request: z.input<typeof N.requestEmailChange>,
	): Promise<Reply<{ status: "verification_requested" }>>;
	confirmEmailChange(request: z.input<typeof N.confirmEmailChange>): Promise<CredentialOutcome>;
	changePassword(request: ChangePasswordRequest): Promise<CredentialOutcome>;

	/** The account's own timezone preference, as the contract's timezonePreference. */
	getPersonalTimezone(): Promise<Reply<TimezonePreference>>;
	previewPersonalTimezone(
		request: z.input<typeof N.previewPersonalTimezoneRequest>,
	): Promise<Reply<PersonalTimezonePreview>>;
	setPersonalTimezone(request: z.input<typeof N.setPersonalTimezoneRequest>): Promise<Reply<PersonalTimezoneResult>>;

	requestAccountDeletion(request: z.input<typeof S.requestAccountDeletion>): Promise<Reply<DeletionStatus>>;
	requestWorkspaceDeletion(request: z.input<typeof S.requestWorkspaceDeletion>): Promise<Reply<DeletionStatus>>;
}

/** The restricted deletion session (REQ-IDN-032): status and cancel for one exact request, nothing else. */
export interface DeletionPort {
	getStatus(): Promise<Reply<DeletionStatus>>;
	cancel(expectedRevision: string): Promise<Reply<DeletionStatus>>;
}

/** A fresh request key per user action. A retry of the same action reuses its key. */
export function newRequestKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}
