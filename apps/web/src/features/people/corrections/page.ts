import type * as c from "@everyfield/contracts/people";
import "server-only";
import type { z } from "zod";
import type { PersonRecords } from "../assessments/model.ts";
import type { PersonFields } from "../fields/model.ts";
import type { PlantSeat } from "@/server/request-context";
import { readPersonView } from "../server.ts";
import type { DuplicateHints } from "./server.ts";

type PersonId = z.infer<typeof c.personRequest>["personId"];
type PlantPerson = z.infer<typeof c.plantPerson>;
export type PersonPage = {
	person: PlantPerson;
	activities: z.infer<typeof c.activitiesResult> | null;
	fields: PersonFields | null;
	records: PersonRecords | null;
	duplicates: DuplicateHints | null;
};
export async function readPersonPageNow(v: PlantSeat, personId: PersonId): Promise<PersonPage | null> {
	const r = await readPersonView(v, personId);
	if (r.status !== "ok") return null;
	const { found, activities, fields, records, duplicates } = r.value;
	if (found.status !== "available" || !("stage" in found.person)) return null;
	return {
		person: found.person,
		activities: activities?.status === "ok" ? activities.value : null,
		fields,
		records,
		duplicates,
	};
}
