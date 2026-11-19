import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { personFields, readPersonPhoto } from "@everyfield/domain/people";
import { z } from "zod";
import { read } from "../server.ts";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "./server.ts";
import { transient } from "@/server/platform/transient";

const params = z.object({ personId: z.uuid(), versionId: z.uuid() });
const gone = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(
	request: Request,
	{ params: raw }: { params: Promise<{ personId: string; versionId: string }> },
) {
	const p = params.safeParse(await raw);
	const v = await getViewer();
	const people = v.people;
	if (!p.success || !people) return gone();
	const etag = `"${p.data.versionId}"`;
	const headers = { "Cache-Control": "private, no-cache", ETag: etag, "X-Content-Type-Options": "nosniff" };
	if (request.headers.get("if-none-match") === etag) {
		const now = await read(people, (tx, ctx) => personFields.getPersonPhoto(tx, ctx, { personId: p.data.personId }));
		const same = now.status === "ok" && now.value.status === "available" && now.value.versionId === p.data.versionId;
		return same ? new Response(null, { status: 304, headers }) : gone();
	}
	const storage = privateStorage();
	if (!storage) return gone();
	const db = requestDatabase();
	const photo = await transient(
		{ component: "people", outcome: "photo_read_failed" },
		() => readPersonPhoto(db, storage, peopleContext(people), p.data),
		null,
	);
	if (photo?.status !== "ok") return gone();
	return new Response(Buffer.from(photo.value.bytes), {
		headers: { ...headers, "Content-Type": photo.value.mediaType, "Content-Length": String(photo.value.bytes.length) },
	});
}
