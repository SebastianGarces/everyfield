import "server-only";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { meetingId as meetingIdSchema } from "@everyfield/contracts/meetings";
import { documentsReader } from "@everyfield/domain/documents";
import { NextResponse } from "next/server";

// GET /meetings/[meetingId]/agenda (REQ-DOC-007): the meeting's agenda as a PDF the browser shows inline. The session
// statement and one read statement are all it sends. It stores nothing: no generated document, no audit row, no file.
// Signed out goes to sign-in and comes back. A seat with no access and a meeting that is not this church's read the
// same: 404 with no bytes. Each request reads the meeting again; nothing is cached.

const NO_STORE = { "Cache-Control": "private, no-store" };
const missing = () =>
	new Response("Not found", { status: 404, headers: { ...NO_STORE, "Content-Type": "text/plain" } });

export async function agendaRoute(request: Request, context: { params: Promise<{ meetingId: string }> }) {
	const raw = (await context.params).meetingId;
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") {
		const signin = new URL("/signin", request.url);
		signin.searchParams.set("returnTo", `/meetings/${encodeURIComponent(raw)}/agenda`);
		return NextResponse.redirect(signin);
	}
	const id = meetingIdSchema.safeParse(raw);
	const db = requestDatabase();
	if (!id.success || viewer.status !== "active" || !viewer.authority) return missing();
	if (!db) return new Response("Try again in a moment.", { status: 503, headers: NO_STORE });
	try {
		const reply = await documentsReader.printAgenda(db, viewer.authority, { meetingId: id.data });
		if (reply.status === "refused") return reply.error.code === "render_failed" ? failed() : missing();
		const { templateId, localDate, artifact } = reply.value;
		return new Response(Buffer.from(artifact, "base64"), {
			headers: {
				...NO_STORE,
				"Content-Type": "application/pdf",
				"Content-Disposition": `inline; filename="${templateId}-${localDate}.pdf"`,
			},
		});
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "agenda_print_failed", error: String(error) }));
		return failed();
	}
}
const failed = () =>
	new Response("The agenda did not print. Try again in a moment.", { status: 503, headers: NO_STORE });
