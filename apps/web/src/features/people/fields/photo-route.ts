import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { personFields, readPersonPhoto } from "@everyfield/domain/people";
import { z } from "zod";
import { read } from "../server.ts";
import { peopleContext, privateStorage } from "./server.ts";

// GET /people/{personId}/photo/{versionId}: the exact photo version of a live person, for a reader who can see that
// person now (REQ-PPL-005). There is no storage link. Every request rechecks the session, seat and person: a browser
// that already holds this version revalidates with its ETag and gets 304 after a one-statement check, never stale access.

const params = z.object({ personId: z.uuid(), versionId: z.uuid() });
const gone = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(
	request: Request,
	{ params: raw }: { params: Promise<{ personId: string; versionId: string }> },
) {
	const p = params.safeParse(await raw);
	const v = await getViewer();
	if (!p.success || !v?.people) return gone();
	const etag = `"${p.data.versionId}"`;
	const headers = { "Cache-Control": "private, no-cache", ETag: etag, "X-Content-Type-Options": "nosniff" };
	if (request.headers.get("if-none-match") === etag) {
		const now = await read(v.people, (tx, ctx) => personFields.getPersonPhoto(tx, ctx, { personId: p.data.personId }));
		const same = now.status === "ok" && now.value.status === "available" && now.value.versionId === p.data.versionId;
		return same ? new Response(null, { status: 304, headers }) : gone();
	}
	const storage = privateStorage();
	const db = requestDatabase();
	if (!storage || !db) return gone();
	const photo = await readPersonPhoto(db, storage, peopleContext(v.people), p.data).catch(() => null);
	if (photo?.status !== "ok") return gone();
	return new Response(Buffer.from(photo.value.bytes), {
		headers: { ...headers, "Content-Type": photo.value.mediaType, "Content-Length": String(photo.value.bytes.length) },
	});
}
