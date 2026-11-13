"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";

// The current photos of the people Evry's result cards show (REQ-IDN-006). The panel asks for them here, apart from
// Evry: a photo never enters a saved conversation, a tool result or the model's context, and each read sees the
// photos as they are now.

/** Each person's photo route, by person id. A person without a photo, a refused read or a failure has no entry. */
export async function readRowPhotos(personIds: unknown): Promise<Record<string, string>> {
	const v = await getViewer();
	const db = requestDatabase();
	if (!v?.people || !db) return {};
	try {
		const reply = await readPersonPhotos(db, new PeopleReadContext(v.people.authority), { personIds });
		if (reply.status !== "ok") return {};
		return Object.fromEntries(reply.value.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]));
	} catch (error) {
		console.error(JSON.stringify({ component: "evry", outcome: "row_photos_failed", error: String(error) }));
		return {};
	}
}
