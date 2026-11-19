import "server-only";
import { privateStorage } from "@everyfield/db/schema";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	checkProposal,
	createConversation,
	listConversations,
	openLatestConversation,
	pipelineListsPeople,
	readCatalog,
	readConversation,
	readReview,
	readStagedPhoto,
	retryTurn,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
} from "@everyfield/evry";
import { mutatingRoute, privateHeaders } from "../platform/boundary";
import { drainEffects, drainTurns, errorResponse, evryMail, evryResponse, requestActor } from "./index";
import { requestDatabase } from "../database";
import { evryNative } from "./native";

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
	evryResponse(async (db, actor) => createConversation(db, actor, await request.json().catch(() => null))),
);

export const conversationGet = async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) =>
		readConversation(db, actor, id, Number(new URL(request.url).searchParams.get("after") ?? 0)),
	);
};

export const conversationCancelPost = mutatingRoute(async (_request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse((db, actor) => cancelTurn(db, actor, id));
});

export const conversationRetryPost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await retryTurn(db, actor, id, await request.json().catch(() => null));
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
});

export const conversationTurnsPost = mutatingRoute(async (request: Request, { params }: IdParams) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await submitTurn(db, actor, id, await request.json().catch(() => null));
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
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
		const approved = await approveProposal(db, actor, id, await request.json().catch(() => null), privateStorage());
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
		reviseProposal(db, actor, id, await request.json().catch(() => null), evryMail(), evryNative()),
	);
});
