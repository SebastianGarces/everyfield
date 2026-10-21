import { flushTraces, observeConversation, projectError, readConversation } from "@everyfield/evry";
import { after as afterResponse } from "next/server";
import { errorResponse, evryDatabase, requestActor } from "@/server/evry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Server-sent events of the conversation's saved events after `after` (or Last-Event-ID on reconnect). Each event's id
 * is its sequence, so a reconnect resumes exactly where it stopped. Reading never starts or repeats a run.
 */
export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const after = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
	let db, actor;
	try {
		db = evryDatabase();
		actor = await requestActor();
		// A foreign or missing conversation answers like any other refused read, before the stream opens.
		await readConversation(db, actor, id, Number.isInteger(after) && after >= 0 ? after : 0);
	} catch (error) {
		return errorResponse(error);
	}
	// The first delivery of a turn's text adds a span to that turn's trace; it is exported once the stream ends.
	afterResponse(flushTraces);
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
			try {
				for await (const event of observeConversation(db, actor, id, after, request.signal))
					controller.enqueue(
						encoder.encode(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
					);
				controller.enqueue(encoder.encode("event: idle\ndata: {}\n\n"));
			} catch (error) {
				controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(projectError(error))}\n\n`));
			} finally {
				clearInterval(heartbeat);
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "private, no-store, no-transform",
			"X-Content-Type-Options": "nosniff",
			"X-Accel-Buffering": "no",
		},
	});
};
