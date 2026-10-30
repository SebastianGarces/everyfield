import type * as B from "@everyfield/contracts/branding";
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
/**
 * The read the server started with the page at that section's address: a settings section, or the brand kit (which
 * has its own contract and refusal codes).
 */
export type SectionSeed =
	{ request: GetSectionRequest; value: Promise<Reply<SectionResult>> } | { brand: Promise<BrandReply<BrandView>> };
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

// The church brand kit (WP-104). Its operations and refusals come from the branding contract.
export type BrandKit = B.BrandKit;
export type BrandError = B.BrandError;
export type BrandReply<T> = B.BrandReply<T>;
export type SaveBrandRequest = z.input<typeof B.saveSettingsRequest>;
export type ResetBrandRequest = z.input<typeof B.resetRequest>;
/** The saved kit and the church name the preview sets in type in the logo slots. */
export type BrandView = { kit: BrandKit; churchName: string };

/** A section the dialog can show. Seats come from WP-008/ui through the same frame. */
export type SectionKey = "church" | "brand" | "organization" | "seats" | "notifications" | "sharing" | "account";

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
	/** Your photo, email, password, own time zone and deletion. */
	flows: FlowPort;
	/** The church brand kit: read, save one patch, reset. */
	brand: BrandPort;
}

export interface BrandPort {
	get(): Promise<BrandReply<BrandView>>;
	save(request: SaveBrandRequest): Promise<BrandReply<BrandKit>>;
	reset(request: ResetBrandRequest): Promise<BrandReply<BrandKit>>;
}

/** The photo flow. Its bytes need the private bucket (Q2), so a port without one leaves it out. */
export interface AvatarPort {
	requestAvatarUpload(request: z.input<typeof S.requestAvatarUpload>): Promise<Reply<AvatarUpload>>;
	/** Sends the bytes to the server-owned staging upload. The server verifies type and size again. */
	uploadAvatarBytes(uploadId: string, file: Blob): Promise<Reply<null>>;
	finalizeAvatar(request: z.input<typeof S.finalizeAvatarRequest>): Promise<Reply<AvatarResult>>;
	removeAvatar(request: z.input<typeof S.removeAvatarRequest>): Promise<Reply<AvatarResult>>;
	/** The authenticated delivery route for one avatar version (avatarRoute). Never a storage key or bearer URL. */
	avatarSrc(avatar: AvatarReference): string;
}

export interface FlowPort {
	/** Absent until a private bucket exists (Q2): Your account then shows no Photo row. */
	avatar?: AvatarPort;

	requestEmailChange(
		request: z.input<typeof N.requestEmailChange>,
	): Promise<Reply<{ status: "verification_requested" }>>;
	changePassword(request: ChangePasswordRequest): Promise<CredentialOutcome>;

	previewPersonalTimezone(
		request: z.input<typeof N.previewPersonalTimezoneRequest>,
	): Promise<Reply<PersonalTimezonePreview>>;
	setPersonalTimezone(request: z.input<typeof N.setPersonalTimezoneRequest>): Promise<Reply<PersonalTimezoneResult>>;

	requestAccountDeletion(request: z.input<typeof S.requestAccountDeletion>): Promise<Reply<DeletionStatus>>;
	/** Absent until church workspace deletion has a server action: the Church section then leaves it out. */
	requestWorkspaceDeletion?(request: z.input<typeof S.requestWorkspaceDeletion>): Promise<Reply<DeletionStatus>>;
}

/** The restricted deletion session (REQ-IDN-032): status and cancel for one exact request, nothing else. */
export interface DeletionPort {
	/** Fresh proof of the original login. It opens the restricted session for the account's current request. */
	open(request: z.input<typeof N.openAccountDeletionRequest>): Promise<Reply<DeletionStatus>>;
	/** Refused with proof_invalid when no restricted session is open. */
	getStatus(): Promise<Reply<DeletionStatus>>;
	cancel(expectedRevision: string): Promise<Reply<DeletionStatus>>;
}

/** A fresh request key per user action. A retry of the same action reuses its key. */
export function newRequestKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}
