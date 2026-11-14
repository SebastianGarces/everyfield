"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { dashboardWriter } from "@everyfield/domain/dashboard";

// The browser boundary of Overview's one write. The dashboard writer parses the prompt with the strict contract and
// rechecks the live seat inside its statement. Dismissing twice writes once.

/** Hides an optional prompt for the signed-in person in this church, in every browser. */
export async function dismissPrompt(prompt: unknown): Promise<{ status: "ok" | "failed" }> {
	const authority = (await getViewer())?.authority;
	const db = requestDatabase();
	if (!authority || !db) return { status: "failed" };
	try {
		const reply = await dashboardWriter.dismissPrompt(db, authority, { prompt });
		return { status: reply.status === "ok" ? "ok" : "failed" };
	} catch (error) {
		console.error(JSON.stringify({ component: "overview", outcome: "dismiss_failed", error: String(error) }));
		return { status: "failed" };
	}
}
