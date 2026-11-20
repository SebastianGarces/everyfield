import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { meetingId as meetingIdSchema } from "@everyfield/contracts/meetings";
import { documentsReader } from "@everyfield/domain/documents";
import { NextResponse } from "next/server";
import { transient } from "../../server/platform/transient.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const missing = () =>
	new Response("Not found", { status: 404, headers: { ...NO_STORE, "Content-Type": "text/plain" } });

export async function agendaRoute(request: Request, context: { params: Promise<{ meetingId: string }> }) {
	const raw = (await context.params).meetingId;
	const viewer = await getViewer();
	if (viewer.status === "unauthenticated") {
		const signin = new URL("/signin", request.url);
		signin.searchParams.set("returnTo", `/meetings/${encodeURIComponent(raw)}/agenda`);
		return NextResponse.redirect(signin);
	}
	const id = meetingIdSchema.safeParse(raw);
	const authority = viewer.status === "active" ? viewer.authority : null;
	if (!id.success || !authority) return missing();
	const db = requestDatabase();
	return transient(
		{ component: "documents", outcome: "agenda_print_failed" },
		async () => {
			const reply = await documentsReader.printAgenda(db, authority, { meetingId: id.data });
			if (reply.status === "refused") return reply.error.code === "render_failed" ? failed() : missing();
			const { templateId, localDate, artifact } = reply.value;
			return new Response(Buffer.from(artifact, "base64"), {
				headers: {
					...NO_STORE,
					"Content-Type": "application/pdf",
					"Content-Disposition": `inline; filename="${templateId}-${localDate}.pdf"`,
				},
			});
		},
		failed(),
	);
}
const failed = () =>
	new Response("The agenda did not print. Try again in a moment.", { status: 503, headers: NO_STORE });
