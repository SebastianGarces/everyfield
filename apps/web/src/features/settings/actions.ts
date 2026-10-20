"use server";

import * as S from "@everyfield/contracts/settings";
import type { z } from "zod";
import type {
	GetSectionRequest,
	PlantTimezonePreview,
	PlantTimezoneResult,
	Reply,
	SavedSection,
	SaveSectionRequest,
	SectionResult,
} from "./port";
import { run } from "./server";

// The settings server actions: one per operation the product screens use. Each parses the browser's request with the
// settings contract (server.ts run), so a field the contract refuses never reaches the database, and the owner comes
// from the session, never from the browser.

export async function getSection(request: GetSectionRequest): Promise<Reply<SectionResult>> {
	return run(
		"read",
		S.getSectionRequest,
		request,
		(r) => r.section,
		(ops, tx, context, r) => ops.sections.getSection(tx, context, r),
	);
}

export async function saveSection(request: SaveSectionRequest): Promise<Reply<SavedSection>> {
	return run(
		"write",
		S.saveSectionRequest,
		request,
		(r) => r.input.section,
		(ops, tx, context, r) => ops.sections.saveSection(tx, context, r),
	);
}

/** A preview stores what it shows, so it runs as a write. */
export async function previewPlantTimezone(
	request: z.input<typeof S.previewPlantTimezoneRequest>,
): Promise<Reply<PlantTimezonePreview>> {
	return run(
		"write",
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
		"write",
		S.setPlantTimezoneRequest,
		request,
		() => "plant",
		(ops, tx, context, r) => ops.timezones.setPlantTimezone(tx, context, r),
	);
}
