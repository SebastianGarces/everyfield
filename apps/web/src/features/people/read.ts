import { getViewer } from "@/server/request-context";
import * as c from "@everyfield/contracts/people";
import { peopleReader, personFields } from "@everyfield/domain/people";
import "server-only";
import { defineReads } from "../../server/platform/reads.ts";
import { outcome } from "./boundary.ts";
import { read } from "./server.ts";

const HOUSEHOLDS_FOUND = 20;
const WITNESSES_FOUND = 8;

export const GET = defineReads(
	async () => (await getViewer())?.people ?? null,
	"access_denied",
	(get) => ({
		households: get(c.listHouseholdsRequest.pick({ search: true }), async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) =>
					personFields.listHouseholds(tx, ctx, { ...v, page: 1, limit: HOUSEHOLDS_FOUND }),
				),
				(r) => r,
			),
		),
		witnesses: get(c.listPeopleRequest.omit({ limit: true }), async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) => peopleReader.listPeople(tx, ctx, { ...v, limit: WITNESSES_FOUND })),
				(r) => r.items.map((p) => ({ id: p.id, name: p.displayName, detail: p.email ?? p.phone ?? "" })),
			),
		),
	}),
);
