import { privateStorage } from "@everyfield/db/schema";
import { timingSafeEqual } from "node:crypto";
import { requestDatabase } from "@/server/database";
import { runDueObjectCleanup } from "@/server/jobs/object-cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;

// Daily: deletes expired uploads that were never used and any released object a request's own cleanup missed.
export async function GET(request: Request): Promise<Response> {
	const secret = process.env.CRON_SECRET;
	if (!secret) return Response.json({ status: "unavailable" }, { status: 503 });
	const expected = Buffer.from(`Bearer ${secret}`);
	const actual = Buffer.from(request.headers.get("authorization") ?? "");
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		return Response.json({ status: "unauthorized" }, { status: 401 });
	const db = requestDatabase();
	const storage = privateStorage();
	if (!db || !storage) return Response.json({ status: "unavailable" }, { status: 503 });
	return Response.json({ removed: await runDueObjectCleanup(db, storage, 100) });
}
