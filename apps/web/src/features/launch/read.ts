import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { plantSeat } from "@/server/request-context";
import { read } from "./server.ts";

export const GET = defineReads(
	async () => ({ viewer: await plantSeat() }),
	"access_denied",
	(get) => ({
		offers: get(z.undefined(), ({ viewer }) =>
			read(viewer, (r, db, authority) => r.readGatheringOffers(db, authority)),
		),
		guests: get(z.strictObject({ query: z.string() }), ({ viewer }, v) =>
			read(viewer, (r, db, authority) => r.suggestGuests(db, authority, v.query)),
		),
		history: get(z.undefined(), ({ viewer }) => read(viewer, (r, db, authority) => r.readJournal(db, authority))),
	}),
);
