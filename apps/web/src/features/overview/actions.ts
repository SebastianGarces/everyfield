"use server";

import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import { dashboardWriter } from "@everyfield/domain/dashboard";
import { transient } from "../../server/platform/transient.ts";

export async function dismissPrompt(prompt: unknown): Promise<{ status: "ok" | "failed" }> {
	const authority = await viewerActor();
	if (!authority) return { status: "failed" };
	const db = requestDatabase();
	return transient(
		{ component: "overview", outcome: "dismiss_failed" },
		async () => {
			const reply = await dashboardWriter.dismissPrompt(db, authority, { prompt });
			return { status: reply.status === "ok" ? "ok" : "failed" };
		},
		{ status: "failed" },
	);
}
