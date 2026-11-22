import "server-only";
import { privateStorage } from "@everyfield/db/schema";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	checkProposal,
	createConversation,
	flushTraces,
	listConversations,
	observeRun,
	openLatestConversation,
	pipelineListsPeople,
	projectError,
	readCatalog,
	readConversation,
	readReview,
	readStagedPhoto,
	retryTurn,
	retryUnresolvedEffects,
	reviseProposal,
	stageAttachment,
	submitTurn,
} from "@everyfield/evry";
import { logFailure } from "@everyfield/domain/log";
import { after as afterResponse } from "next/server";
import { mutatingRoute, privateHeaders } from "../platform/boundary";
import { drainEffects, drainTurns, errorResponse, evryMail, evryResponse, requestActor } from "./index";
import { requestDatabase } from "../database";
import { evryNative } from "./native";
import { parseJson } from "../platform/json.ts";

type IdParams = { params: Promise<{ id: string }> };

export const catalogGet = () => evryResponse(async (_db, actor) => readCatalog(actor));

export const conversationsGet = (request: Request) =>
	evryResponse((db, actor) => {
		const url = new URL(request.url);
		return listConversations(db, actor, {
			search: url.searchParams.get("q") ?? undefined,
			page: Number(url.searchParams.get("page") ?? 1),
		});
	});

export const conversationsPost = mutatingRoute((request: Request) =>
	evryResponse(async (db, actor) => createConversation(db, actor, parseJson(await request.text()) ?? null)),
);

export const conversationGet = async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) =>
		readConversation(db, actor, id, Number(new URL(request.url).searchParams.get("after") ?? 0)),
	);
};

export const conversationStreamGet = async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	const given = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
	const after = Number.isInteger(given) && given >= 0 ? given : 0;
	let db, actor, first;
	try {
		db = requestDatabase();
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
				logFailure({ component: "evry", outcome: "stream_failed" }, error);
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

export const conversationCancelPost = mutatingRoute(async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) => cancelTurn(db, actor, id));
});

export const conversationRetryPost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await retryTurn(db, actor, id, parseJson(await request.text()) ?? null);
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
});

export const conversationTurnsPost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await submitTurn(db, actor, id, parseJson(await request.text()) ?? null);
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
});

export const conversationAttachmentsPost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) =>
		stageAttachment(db, privateStorage(), actor, id, parseJson(await request.text()) ?? null),
	);
});

export const openGet = () =>
	evryResponse(async (db, actor) => ({
		...((await openLatestConversation(db, actor)) ?? { conversation: null }),
		pipeline: await pipelineListsPeople(db, actor),
	}));

export const proposalGet = async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) => readReview(db, actor, id));
};

export const proposalApprovePost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const approved = await approveProposal(db, actor, id, parseJson(await request.text()) ?? null, privateStorage());
		if (!approved.replayed || approved.proposal.executing) drainEffects();
		return approved;
	});
});

export const proposalCancelPost = mutatingRoute(async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) => cancelProposal(db, actor, id));
});

export const proposalCheckPost = mutatingRoute(async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => checkProposal(db, actor, id, evryMail()));
});

export const proposalPhotoGet = async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	try {
		const photo = await readStagedPhoto(requestDatabase(), privateStorage(), await requestActor(), id);
		return new Response(Buffer.from(photo.bytes), {
			headers: { ...privateHeaders, "Content-Type": photo.mediaType, "Content-Length": String(photo.bytes.length) },
		});
	} catch (error) {
		return errorResponse(error);
	}
};

export const proposalRetryPost = mutatingRoute(async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const retried = await retryUnresolvedEffects(db, actor, id);
		if (retried.retried) drainEffects();
		return retried;
	});
});

export const proposalRevisePost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) =>
		reviseProposal(db, actor, id, parseJson(await request.text()) ?? null, evryMail(), evryNative()),
	);
});
