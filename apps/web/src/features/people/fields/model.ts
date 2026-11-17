import type * as people from "@everyfield/contracts/people";
import { householdRole, PHOTO_MAX_BYTES, photoMime, proficiency, skillCategory } from "@everyfield/contracts/people";
import type { Tone } from "@everyfield/ui/display";
import type { z } from "zod";

export type PersonTag = z.infer<typeof people.personTag>;
export type ChurchTag = z.infer<typeof people.tag>;
export type Skill = z.infer<typeof people.skill>;
export type SkillCategory = z.infer<typeof people.skillCategory>;
export type Proficiency = z.infer<typeof people.proficiency>;
export type HouseholdRole = z.infer<typeof people.householdRole>;
export type HouseholdResult = z.infer<typeof people.householdResult>;
export type Household = Extract<HouseholdResult, { status: "available" }>;
export type HouseholdSummary = z.infer<typeof people.household>;
export type Membership = z.infer<typeof people.householdMembership>;
export type PhotoResult = z.infer<typeof people.personPhotoResult>;

export type PersonFields = {
	tags: PersonTag[] | null;
	skills: Skill[] | null;
	household: HouseholdResult | null;
	photo: PhotoResult;
};

export const SKILL_CATEGORIES = skillCategory.options;
export const CATEGORY_LABEL: Record<SkillCategory, string> = {
	worship: "Worship",
	tech: "Tech",
	admin: "Admin",
	teaching: "Teaching",
	hospitality: "Hospitality",
	leadership: "Leadership",
	other: "Other",
};
export const PROFICIENCIES = proficiency.options;
export const PROFICIENCY_LABEL: Record<Proficiency, string> = {
	beginner: "Beginner",
	intermediate: "Intermediate",
	advanced: "Advanced",
	expert: "Expert",
};
export const ROLES = householdRole.options;
export const ROLE_LABEL: Record<HouseholdRole, string> = {
	head: "Head",
	spouse: "Spouse",
	child: "Child",
	other: "Other",
};

export const TAG_COLORS = ["gray", "green", "teal", "blue", "purple", "amber", "pink"] as const;
export type TagColorChoice = (typeof TAG_COLORS)[number];
export const TAG_COLOR_LABEL: Record<TagColorChoice, string> = {
	gray: "Gray",
	green: "Green",
	teal: "Teal",
	blue: "Blue",
	purple: "Purple",
	amber: "Amber",
	pink: "Pink",
};
const NAMED_TONE: Record<string, Tone> = {
	gray: "ink",
	red: "magenta",
	orange: "amber",
	amber: "amber",
	yellow: "amber",
	green: "green",
	teal: "teal",
	blue: "blue",
	indigo: "violet",
	purple: "violet",
	pink: "magenta",
};
export function tagLook(color: string | null): { tone?: Tone; dot?: string } {
	if (!color) return {};
	if (color.startsWith("#")) return { dot: color };
	return { tone: NAMED_TONE[color] };
}

export function skillGroups(skills: readonly Skill[]): { category: SkillCategory; skills: Skill[] }[] {
	return SKILL_CATEGORIES.map((category) => ({
		category,
		skills: skills.filter((s) => s.category === category),
	})).filter((g) => g.skills.length > 0);
}

export function addressLine(a: {
	street?: string | null;
	city?: string | null;
	stateProvince?: string | null;
	postalCode?: string | null;
	country?: string | null;
}): string | null {
	const line = [a.street, [a.city, a.stateProvince].filter(Boolean).join(", "), a.postalCode, a.country]
		.filter((x) => x && x.trim())
		.join(" · ");
	return line || null;
}

export function photoProblem(file: { size: number; type: string }): string | null {
	if (file.size === 0) return "This file is empty. Choose a photo.";
	if (!photoMime.safeParse(file.type).success) return "Use a JPG, PNG or WebP photo.";
	if (file.size > PHOTO_MAX_BYTES) return "Choose a photo smaller than 3 MB.";
	return null;
}

export function takeFile(input: { files: ArrayLike<File> | null; value: string }): File | null {
	const file = input.files?.[0] ?? null;
	input.value = "";
	return file;
}

export function householdChange(change: { from: Membership | null; to: Membership | null }): string {
	const { from, to } = change;
	if (!from && to) return `Joined ${to.name} as ${ROLE_LABEL[to.role].toLowerCase()}`;
	if (from && !to) return `Left ${from.name}`;
	if (from && to && from.householdId === to.householdId && from.role !== to.role)
		return `Role in ${to.name} changed to ${ROLE_LABEL[to.role].toLowerCase()}`;
	if (from && to) return `Moved from ${from.name} to ${to.name}`;
	return "Household changed";
}

export function membershipOf(result: HouseholdResult | null, personId: string): Membership | null {
	if (result?.status !== "available") return null;
	const me = result.members.find((m) => m.personId === personId);
	return me ? { householdId: result.household.id, name: result.household.name, role: me.role } : null;
}

export const photoSrc = (photo: PhotoResult): string | undefined =>
	photo.status === "available" ? `/people/${photo.personId}/photo/${photo.versionId}` : undefined;
