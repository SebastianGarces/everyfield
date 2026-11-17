"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { dashboardWriter } from "@everyfield/domain/dashboard";

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
