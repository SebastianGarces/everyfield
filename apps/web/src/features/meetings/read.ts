import { getViewer } from "@/server/request-context";
import { searchPeople } from "@everyfield/domain/people";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { read as readPeople } from "../people/server.ts";
import type { Outcome } from "./model.ts";

const PEOPLE_FOUND = 8;

export const GET = defineReads(
	async () => (await getViewer())?.people ?? null,
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
	}),
);
