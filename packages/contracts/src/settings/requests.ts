import { z } from "zod";
import { timeZone } from "../common/time.ts";
import { recordId, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { profileFields } from "../organizations/requests.ts";
import { organizationOwner, plantOwner } from "../organizations/subjects.ts";
import {
	affiliationPatch,
	digestSchedule,
	inactivity,
	notificationPatch,
	plantProfile,
	settingsName,
} from "./values.ts";

export const getSectionRequest = z.discriminatedUnion("section", [
	z.strictObject({ section: z.literal("account") }),
	z.strictObject({ section: z.literal("notifications") }),
	z.strictObject({ section: z.literal("plant"), plant: plantOwner }),
	z.strictObject({ section: z.literal("teams"), plant: plantOwner, teamId: recordId }),
	z.strictObject({ section: z.literal("organization"), organization: organizationOwner }),
	z.strictObject({ section: z.literal("affiliations"), plant: plantOwner, organization: organizationOwner }),
]);
const profilePatch = plantProfile.partial().refine((v) => Object.values(v).some((x) => x !== undefined));
export const plantChange = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("profile"), patch: profilePatch }),
	z.strictObject({ kind: z.literal("inactivity"), value: inactivity }),
	z.strictObject({ kind: z.literal("digest"), value: digestSchedule }),
]);
export const saveSectionRequest = commandEnvelope(
	z.discriminatedUnion("section", [
		z.strictObject({ section: z.literal("account"), name: settingsName }),
		z.strictObject({ section: z.literal("notifications"), patch: notificationPatch }),
		z.strictObject({
			section: z.literal("plant"),
			plant: plantOwner,
			change: plantChange,
		}),
		z.strictObject({ section: z.literal("teams"), plant: plantOwner, teamId: recordId, name: settingsName }),
		z.strictObject({
			section: z.literal("organization"),
			organization: organizationOwner,
			patch: profileFields.partial().refine((v) => Object.values(v).some((x) => x !== undefined)),
		}),
		z.strictObject({
			section: z.literal("affiliations"),
			plant: plantOwner,
			organization: organizationOwner,
			relationshipId: recordId,
			expectedConsentRevision: revision,
			patch: affiliationPatch,
		}),
	]),
);
// The envelope's expectedRevision is the relationship revision for affiliation
// writes, the exact section revision otherwise. No caller account/role/origin.
export const updatePlantProfileRequest = commandEnvelope(z.strictObject({ plant: plantOwner, patch: profilePatch }));
export const setDigestScheduleRequest = commandEnvelope(
	z.strictObject({ plant: plantOwner, schedule: digestSchedule }),
);
export const previewPlantTimezoneRequest = z.strictObject({ plant: plantOwner, timeZone });
export const setPlantTimezoneRequest = commandEnvelope(
	z.strictObject({ plant: plantOwner, timeZone, previewId: recordId }),
);
export const avatarMime = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const requestAvatarUpload = z.strictObject({
	mime: avatarMime,
	byteLength: z
		.int()
		.min(1)
		.max(3 * 1024 * 1024),
});
// Upload handle names server-owned staging state; keys/URLs/MIME attestations
// from the client never substitute for server byte/type verification.
export const finalizeAvatarRequest = commandEnvelope(z.strictObject({ uploadId: recordId }));
export const removeAvatarRequest = commandEnvelope(z.strictObject({}));
export const getAvatarRequest = z.strictObject({ versionId: recordId });
export const requestAccountDeletion = commandEnvelope(z.strictObject({ confirmed: z.literal(true) }));
export const requestWorkspaceDeletion = commandEnvelope(
	z.strictObject({ plant: plantOwner, confirmed: z.literal(true) }),
);
// One church form submission: up to three changes of different kinds, one write, one audit row and one request key.
export const saveChurchRequest = commandEnvelope(
	z
		.strictObject({ plant: plantOwner, changes: z.array(plantChange).min(1).max(3) })
		.refine((v) => new Set(v.changes.map((c) => c.kind)).size === v.changes.length),
);
export type GetSectionRequest = z.infer<typeof getSectionRequest>;
export type SaveSectionRequest = z.infer<typeof saveSectionRequest>;
export type PlantChange = z.infer<typeof plantChange>;
