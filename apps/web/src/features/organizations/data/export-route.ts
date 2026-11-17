import "server-only";
import { loadPipelineExport, pipelineActor } from "@/server/organizations/pipeline";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function exportRoute() {
	const who = await pipelineActor();
	if (who.kind !== "seat") return new Response(null, { status: 403, headers: NO_STORE });
	const reply = await loadPipelineExport(who.authority);
	if (reply.status !== "ok")
		return new Response(null, { status: reply.status === "lost" ? 503 : 403, headers: NO_STORE });
	const { text, filename, mediaType, people } = reply.value;
	return new Response(text, {
		headers: {
			...NO_STORE,
			"Content-Type": mediaType,
			"Content-Disposition": `attachment; filename="${filename}"`,
			"X-Export-People": String(people),
		},
	});
}
