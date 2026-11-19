import { flushTraces, observeRun, projectError, readConversation } from "@everyfield/evry";
import { after as afterResponse } from "next/server";
import { errorResponse, evryDatabase, requestActor } from "@/server/evry";

export const maxDuration = 300;

export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	const given = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
	const after = Number.isInteger(given) && given >= 0 ? given : 0;
	let db, actor, first;
	try {
		db = evryDatabase();
		actor = await requestActor();
		first = await readConversation(db, actor, id, after);
	} catch (error) {
		return errorResponse(error);
	}
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
								: `event: live\ndata: ${JSON.stringify(item.live)}\n\n`,
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
