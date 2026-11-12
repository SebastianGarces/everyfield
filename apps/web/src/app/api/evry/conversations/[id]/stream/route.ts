import { flushTraces, observeRun, projectError, readConversation } from "@everyfield/evry";
import { after as afterResponse } from "next/server";
import { errorResponse, evryDatabase, requestActor } from "@/server/evry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Server-sent events of the conversation's saved events after `after` (or Last-Event-ID on reconnect), and the running
 * turn's text as it arrives (`live`, offset-addressed). Each saved event's id is its sequence, so a reconnect resumes
 * exactly where it stopped. Reading never starts or repeats a run.
 */
export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const given = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
	// One cursor for the check and the stream: a malformed value reads from the start instead of opening a stream that
	// then fails.
	const after = Number.isInteger(given) && given >= 0 ? given : 0;
	let db, actor, first;
	try {
		db = evryDatabase();
		actor = await requestActor();
		// A foreign or missing conversation answers like any other refused read, before the stream opens. The page
		// this check reads is the stream's first, so it is read once.
		first = await readConversation(db, actor, id, after);
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
				for await (const item of observeRun(db, actor, id, after, request.signal, { first }))
					controller.enqueue(
						encoder.encode(
							"event" in item
								? `id: ${item.event.sequence}\nevent: ${item.event.kind}\ndata: ${JSON.stringify(item.event)}\n\n`
								: // Live text has no sequence yet: it carries no id, so a reconnect resumes from the saved events.
									`event: live\ndata: ${JSON.stringify(item.live)}\n\n`,
						),
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
