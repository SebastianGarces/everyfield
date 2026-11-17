import type * as B from "@everyfield/contracts/branding";
import type * as S from "@everyfield/contracts/settings";
import type * as N from "@everyfield/contracts/settings/native";
import type { OrderRead, OrderSave } from "../wiki/actions";
import type { Locality, RegionRead, RegionSave, RegionSuggestion } from "./region";
import type { z } from "zod";

export type SettingsError = S.SettingsError;
export type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: SettingsError };

export type SectionResult = z.infer<typeof S.sectionResult>;
export type SavedSection = z.infer<typeof S.savedSectionResult>;
export type SaveSectionRequest = z.input<typeof S.saveSectionRequest>;
export type SaveChurchRequest = z.input<typeof S.saveChurchRequest>;
export type GetSectionRequest = z.input<typeof S.getSectionRequest>;
export type SectionSeed =
	{ request: GetSectionRequest; value: Promise<Reply<SectionResult>> } | { brand: Promise<BrandReply<BrandView>> };
export type PlantOwner = { kind: "plant"; id: string };
export type OrganizationOwner = {
	kind: "organization";
	id: string;
	organizationKind: "sending_church" | "sending_network";
};
export type PlantSettings = z.infer<typeof S.plantSettings>;
export type DigestSchedule = z.infer<typeof S.digestSchedule>;
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
type ChangePasswordRequest = z.input<typeof N.changePasswordRequest>;

export type BrandKit = B.BrandKit;
export type BrandError = B.BrandError;
export type BrandReply<T> = B.BrandReply<T>;
export type SaveBrandRequest = z.input<typeof B.saveSettingsRequest>;
export type ResetBrandRequest = z.input<typeof B.resetRequest>;
export type RequestBrandUpload = z.input<typeof B.uploadRequest>;
export type FinalizeBrandUpload = z.input<typeof B.finalizeUploadRequest>;
export type SuggestBrandColors = z.input<typeof B.suggestColorsRequest>;
export type BrandUploadTicket = z.infer<typeof B.uploadTicket>;
export type SuggestedColors = z.infer<typeof B.suggestedColors>;
export type BrandView = { kit: BrandKit; churchName: string };

export type SectionKey =
	"church" | "brand" | "organization" | "seats" | "notifications" | "sharing" | "wiki" | "account";

export type SettingsViewer =
	| { context: "plant"; accountId: string; plant: PlantOwner; role: "owner" | "admin" | "member" }
	| { context: "organization"; accountId: string; organization: OrganizationOwner; role: "owner" | "admin" | "member" }
	| { context: "account"; accountId: string };

export type Relationship = {
	relationshipId: string;
	revision: string;
	organization: OrganizationOwner;
	organizationName: string;
};

export interface SettingsPort {
	getSection(request: GetSectionRequest): Promise<Reply<SectionResult>>;
	saveSection(request: SaveSectionRequest): Promise<Reply<SavedSection>>;
	saveChurch(request: SaveChurchRequest): Promise<Reply<SavedSection>>;
	previewPlantTimezone(request: z.input<typeof S.previewPlantTimezoneRequest>): Promise<Reply<PlantTimezonePreview>>;
	setPlantTimezone(request: z.input<typeof S.setPlantTimezoneRequest>): Promise<Reply<PlantTimezoneResult>>;
	flows: FlowPort;
	brand: BrandPort;
	wiki: WikiOrderPort;
	region: RegionPort;
}

export type { Locality, RegionRead, RegionSave, RegionSuggestion } from "./region";
export interface RegionPort {
	read(): Promise<RegionRead>;
	suggest(locality: Locality): Promise<RegionSuggestion[] | null>;
	save(input: {
		requestKey: string;
		expectedRevision: string;
		locality: Locality;
		referenceVersionId: string;
		regionItemId: string | null;
	}): Promise<RegionSave>;
}

export type { OrderRead, OrderRow, OrderSave } from "../wiki/actions";

export interface WikiOrderPort {
	read(): Promise<OrderRead>;
	save(requestKey: string, expectedRevision: string, churches: string[], networks: string[]): Promise<OrderSave>;
}

export interface BrandPort {
	get(): Promise<BrandReply<BrandView>>;
	save(request: SaveBrandRequest): Promise<BrandReply<BrandKit>>;
	reset(request: ResetBrandRequest): Promise<BrandReply<BrandKit>>;
	requestUpload(request: RequestBrandUpload): Promise<BrandReply<BrandUploadTicket>>;
	uploadBytes(uploadId: string, file: Blob): Promise<BrandReply<null>>;
	finalizeUpload(request: FinalizeBrandUpload): Promise<BrandReply<BrandKit>>;
	suggestColors(request: SuggestBrandColors): Promise<BrandReply<SuggestedColors>>;
	assetSrc(fileId: string): string;
}

export interface AvatarPort {
	requestAvatarUpload(request: z.input<typeof S.requestAvatarUpload>): Promise<Reply<AvatarUpload>>;
	uploadAvatarBytes(target: AvatarReference, file: Blob): Promise<Reply<null>>;
	finalizeAvatar(request: z.input<typeof S.finalizeAvatarRequest>): Promise<Reply<AvatarResult>>;
	removeAvatar(request: z.input<typeof S.removeAvatarRequest>): Promise<Reply<AvatarResult>>;
	avatarSrc(avatar: AvatarReference): string;
}

export interface FlowPort {
	avatar: AvatarPort;

	requestEmailChange(
		request: z.input<typeof N.requestEmailChange>,
	): Promise<Reply<{ status: "verification_requested" }>>;
	changePassword(request: ChangePasswordRequest): Promise<CredentialOutcome>;

	previewPersonalTimezone(
		request: z.input<typeof N.previewPersonalTimezoneRequest>,
	): Promise<Reply<PersonalTimezonePreview>>;
	setPersonalTimezone(request: z.input<typeof N.setPersonalTimezoneRequest>): Promise<Reply<PersonalTimezoneResult>>;

	requestAccountDeletion(request: z.input<typeof S.requestAccountDeletion>): Promise<Reply<DeletionStatus>>;
	requestWorkspaceDeletion(request: z.input<typeof S.requestWorkspaceDeletion>): Promise<Reply<DeletionStatus>>;
}

export interface DeletionPort {
	open(request: z.input<typeof N.openAccountDeletionRequest>): Promise<Reply<DeletionStatus>>;
	getStatus(): Promise<Reply<DeletionStatus>>;
	cancel(expectedRevision: string): Promise<Reply<DeletionStatus>>;
}

export function newRequestKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}
