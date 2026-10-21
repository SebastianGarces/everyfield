import "server-only";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import { personFields } from "@everyfield/domain/people";
import type { Viewer } from "../server.ts";
import type { PersonFields } from "./model.ts";

/**
 * The person's tags, skills, household and photo, read in the person page's own transaction: four statements whatever
 * the number of tags, skills or members. A part that is refused or fails reads as null, so the rest of the page still
 * shows; a photo that cannot be read shows the initials.
 */
export async function readPersonFields(tx: Transaction, ctx: PeopleContext, personId: string): Promise<PersonFields> {
	const request = { personId };
	const tags = await personFields.getPersonTags(tx, ctx, request);
	const skills = await personFields.getPersonSkills(tx, ctx, request);
	const household = await personFields.getHousehold(tx, ctx, request);
	const photo = await personFields.getPersonPhoto(tx, ctx, request);
	return {
		tags: tags.status === "ok" ? tags.value.tags : null,
		skills: skills.status === "ok" ? skills.value.skills : null,
		household: household.status === "ok" ? household.value : null,
		photo: photo.status === "ok" ? photo.value : { status: "absent" },
	};
}

/** The People context of the byte adapters, which run outside a people transaction. */
export const peopleContext = (v: Viewer): PeopleContext => ({
	session: v.authority.session,
	selected: v.authority.actor.context.owner,
});
