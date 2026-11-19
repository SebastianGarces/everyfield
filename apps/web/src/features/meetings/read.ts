import { getViewer } from "@/server/request-context";
import { listVenuesRequest } from "@everyfield/contracts/meetings";
import { rosterReader, venuesReader } from "@everyfield/domain/meetings";
import { searchPeople } from "@everyfield/domain/people";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { read as readPeople } from "../people/server.ts";
import { readMinistries } from "../teams/server.ts";
import type { Outcome } from "./model.ts";
import { outcome, read } from "./server.ts";

const PEOPLE_FOUND = 8;

export const GET = defineReads(
	async () => (await getViewer()).people ?? null,
	"unavailable",
	(get) => ({
		people: get(
			z.string().trim().max(255),
			async (viewer, query): Promise<Outcome<{ id: string; name: string; detail: string }[]>> => {
				const r = await readPeople(viewer, (tx, ctx) => searchPeople(tx, ctx, query, PEOPLE_FOUND));
				if (r.status === "failed") return { status: "lost" };
				if (r.status === "refused") return { status: "refused", code: r.error.code };
				return { status: "ok", value: r.value };
			},
		),
		ministries: get(z.undefined(), (viewer) => readMinistries(viewer)),
		roster: get(z.strictObject({ meetingId: z.string() }), async (viewer, v) =>
			outcome(await read(viewer, (db, a) => rosterReader.previewRosterImport(db, a, v))),
		),
		venues: get(listVenuesRequest, async (viewer, request) =>
			outcome(await read(viewer, (db, a) => venuesReader.list(db, a, request))),
		),
		venue: get(z.strictObject({ venueId: z.string() }), async (viewer, v) =>
			outcome(await read(viewer, (db, a) => venuesReader.get(db, a, v))),
		),
	}),
);
