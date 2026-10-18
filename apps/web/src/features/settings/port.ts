import type * as S from "@everyfield/contracts/settings";
import type * as N from "@everyfield/contracts/settings/native";
import type { z } from "zod";

// The one door from the settings screens to the API (WP-010/api). Every type comes from the merged contracts in
// packages/contracts/src/settings, so the screens cannot send a field the contract refuses. Until the API merges, the
// design preview passes a fixture port whose replies are parsed by the same schemas (preview/fixtures.ts).

export type SettingsError = S.SettingsError;
export type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: SettingsError };

export type SectionResult = z.infer<typeof S.sectionResult>;
export type SavedSection = z.infer<typeof S.savedSectionResult>;
export type SaveSectionRequest = z.input<typeof S.saveSectionRequest>;
export type GetSectionRequest = z.input<typeof S.getSectionRequest>;
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

export type Command<T> = { requestKey: string; expectedRevision: string; input: T };

/** A section the dialog can show. Seats come from WP-008/ui through the same frame. */
export type SectionKey = "church" | "organization" | "seats" | "notifications" | "sharing" | "account";

/**
 * Who is looking and in which context. The server decides authority again on every call; this only chooses which
 * sections to offer. `role` is the seat in the selected plant; an organization context has an organization role.
 */
export type SettingsViewer =
	| { context: "plant"; accountId: string; plant: PlantOwner; plantName: string; role: "owner" | "admin" | "member" }
	| {
			context: "organization";
			accountId: string;
			organization: OrganizationOwner;
			organizationName: string;
			role: "owner" | "admin" | "member";
	  };

/** One current plant/organization relationship, as WP-007 lists it; `revision` is the relationship revision. */
export type Relationship = {
	relationshipId: string;
	revision: string;
	organization: OrganizationOwner;
	organizationName: string;
};

export interface SettingsPort {
	getSection(request: GetSectionRequest): Promise<Reply<SectionResult>>;
	saveSection(request: SaveSectionRequest): Promise<Reply<SavedSection>>;
	previewPlantTimezone(request: z.input<typeof S.previewPlantTimezoneRequest>): Promise<Reply<PlantTimezonePreview>>;
	setPlantTimezone(request: z.input<typeof S.setPlantTimezoneRequest>): Promise<Reply<PlantTimezoneResult>>;

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

	/**
	 * The account's own timezone preference. The account section DTO does not carry it yet (contract follow-up for
	 * WP-010/api); the reply is the contract's timezonePreference.
	 */
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
