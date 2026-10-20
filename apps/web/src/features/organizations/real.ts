import { revision } from "@everyfield/contracts/common";
import * as C from "@everyfield/contracts/organizations";
import {
	loadConnections,
	loadDisclosure,
	loadHistoryPage,
	loadResidency,
	loadSharing,
	runOrganizationOperation,
} from "./actions";
import type { ConnectionsData } from "./Connections";
import type { ReadHistory } from "./History";
import { Refusal } from "./intent";
import type { ReadDisclosure } from "./InviteDialog";
import type { History, NameOf, OperationName, PendingInvitation, Run } from "./port";
import type { ReadResidency } from "./Residency";
import type { ReadSharing } from "./Sharing";

// The real port (WP-007/ui ruling D11): server actions in, contract parsers out. A server refusal becomes a
// Refusal; a lost reply stays a thrown network error, so useIntent keeps the command frozen.

const RESULT: Partial<Record<OperationName, { parse: (v: unknown) => unknown }>> = {
	"associations.invite": C.invitationResult,
	"associations.resendInvitation": C.invitationResult,
	"associations.revokeInvitation": C.mutationResult,
	"associations.end": C.mutationResult,
	"associations.respondInvitation": C.invitationDecisionResult,
	"associations.getHistory": C.relationshipHistoryResult,
	"privacy.getSharing": C.sharingResult,
	"privacy.setSharing": C.mutationResult,
	"residency.readSharing": C.residencySharingResult,
	"residency.setSharing": C.mutationResult,
	"residency.leave": C.mutationResult,
	"pipelineSharing.readConsent": C.pipelineConsentResult,
	"pipelineSharing.setConsent": C.mutationResult,
	"pipelineSharing.checkAggregateAccess": C.pipelineAggregateAccessResult,
};

/** One own residency link through the server, parsed again here. */
export const readResidency: ReadResidency = async (linkId) => {
	const r = await loadResidency(linkId);
	return { sharing: C.residencySharingResult.parse(r.sharing), linkRevision: revision.parse(r.linkRevision) };
};

/** One of the plant's own connections through the server, parsed again here. */
export const readSharing: ReadSharing = async (relationshipId, request) => {
	const r = await loadSharing(relationshipId, request);
	return { sharing: C.sharingResult.parse(r.sharing), relationshipRevision: revision.parse(r.relationshipRevision) };
};

export const realRun = (async (operation: OperationName, input: unknown) => {
	const schema = RESULT[operation];
	if (!schema) throw new Refusal("unavailable");
	const reply = await runOrganizationOperation(operation, input);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return schema.parse(reply.value);
}) as Run;

const pending = C.invitationResult.omit({});

/** Names learned from the server so far. Pages add to it as they load; unknown IDs get a neutral word. */
export function createNames(initial: Record<string, string>) {
	const known = new Map(Object.entries(initial));
	const learn = (names: Record<string, string>) => {
		for (const [id, name] of Object.entries(names)) known.set(id, name);
	};
	const nameOf: NameOf = (endpoint) =>
		known.get(endpoint.id) ?? (endpoint.kind === "account" ? "another account" : "an organization");
	const load = async (): Promise<ConnectionsData> => {
		const r = await loadConnections();
		learn(r.names);
		const history = C.relationshipHistoryResult.parse(r.history) as ConnectionsData["history"];
		return { history, pending: r.pending.map((p) => pending.parse(p) as PendingInvitation) };
	};
	const readMore: ReadHistory = async (after) => {
		const r = await loadHistoryPage(after);
		learn(r.names);
		return C.relationshipHistoryResult.parse(r.page) as { status: "unavailable" } | History;
	};
	const readDisclosure: ReadDisclosure = async (pair) => {
		const r = await loadDisclosure(pair);
		return r ? C.sharingDisclosure.parse(r) : null;
	};
	return { nameOf, learn, load, readMore, readDisclosure };
}
