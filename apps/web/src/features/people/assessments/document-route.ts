import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { getCommitmentDownload } from "@everyfield/domain/people";
import { z } from "zod";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "../fields/server.ts";

// GET /people/{personId}/commitments/{commitmentId}/document: the signed commitment card's private document (REQ-PPL-014,
// REQ-KNOW-080). Each request checks the live session, seat and role for this exact card, then redirects to a
// five-minute signed link for that object. The browser fetches the bytes from storage directly; no storage key or
// secret reaches the page, and no link exists until someone opens the document.

const params = z.object({ personId: z.uuid(), commitmentId: z.uuid() });
const gone = () =>
	new Response("This document is not available.", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(
	_request: Request,
	{ params: raw }: { params: Promise<{ personId: string; commitmentId: string }> },
) {
	const p = params.safeParse(await raw);
	const v = await getViewer();
	const storage = privateStorage();
	const db = requestDatabase();
	if (!p.success || !v?.people || !storage || !db) return gone();
	const link = await getCommitmentDownload(db, storage, peopleContext(v.people), {
		commitmentId: p.data.commitmentId,
	}).catch(() => null);
	if (link?.status !== "ok") return gone();
	return new Response(null, {
		status: 303,
		headers: { Location: link.value.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}
