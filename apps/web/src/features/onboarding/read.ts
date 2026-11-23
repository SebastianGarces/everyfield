import { getViewer } from "@/server/request-context";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { onboardingEntry } from "./mount";

export const GET = defineReads(
	async () => ({ session: await getViewer() }),
	"unavailable",
	(get) => ({
		entry: get(
			z.undefined(),
			async ({ session }) => ({ status: "ok", value: await onboardingEntry(session) }) as const,
		),
	}),
);
