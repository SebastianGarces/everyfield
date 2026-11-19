import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { getCommitmentDownload } from "@everyfield/domain/people";
import { z } from "zod";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "../fields/server.ts";
import { transient } from "../../../server/platform/transient.ts";

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
	const people = v.people;
	if (!p.success || !people || !storage) return gone();
	const db = requestDatabase();
	const link = await transient(
		{ component: "people", outcome: "document_link_failed" },
		() => getCommitmentDownload(db, storage, peopleContext(people), { commitmentId: p.data.commitmentId }),
		null,
	);
	if (link?.status !== "ok") return gone();
	return new Response(null, {
		status: 303,
		headers: { Location: link.value.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}
