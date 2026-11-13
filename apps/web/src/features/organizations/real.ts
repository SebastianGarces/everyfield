import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import type { Reply } from "@/server/organizations";
import {
	endConnection,
	inviteAssociation,
	leaveResidency,
	loadConnections,
	loadDisclosure,
	loadHistoryPage,
	loadPipelineConsent,
	loadResidency,
	loadSharing,
	resendAssociationInvitation,
	revokeAssociationInvitation,
	savePipelineConsent,
	saveResidencySharing,
	saveSharing,
} from "./actions";
import type { ConnectionsData } from "./Connections";
import { respondRelationshipInvitation } from "./invitation/client.ts";
import type { ReadHistory } from "./History";
import { Refusal } from "./intent";
import type { EndConnection } from "./EndDialog";
import type { ReadDisclosure } from "./InviteDialog";
import type { ReadConsent, SaveConsent } from "./Pipeline";
import type { NameOf, OperationName, Run } from "./port";
import type { ReadResidency, SaveResidency } from "./Residency";
import type { ReadSharing, SaveSharing } from "./Sharing";

// The real port (WP-007/ui ruling D11): one typed server action per operation. The server parses the browser's input
// and answers with the contract value, which the screens trust. A server refusal becomes a Refusal; a lost reply stays
// a thrown network error, so useIntent keeps the command frozen. The one exception is the answer to a relationship
// request, which carries the emailed proof: it goes through POST /api/connections/invitation, never a server function
// argument (rulings U1, D54).

/** The operations the screens call; the contract's other operations have no screen and no door. */
type Actions = { [K in OperationName]?: (input: Ops[K]["input"]) => Promise<Reply<Ops[K]["output"]>> };
const ACTIONS: Actions = {
	"associations.invite": inviteAssociation,
	"associations.resendInvitation": resendAssociationInvitation,
	"associations.revokeInvitation": revokeAssociationInvitation,
	"associations.respondInvitation": respondRelationshipInvitation,
	"residency.leave": leaveResidency,
};

export const readResidency: ReadResidency = loadResidency;
export const saveResidency: SaveResidency = async (command) => {
	const r = await saveResidencySharing(command);
	if (r.reply.status === "refused") throw new Refusal(r.reply.code);
	return r.row;
};
export const readConsent: ReadConsent = loadPipelineConsent;
export const saveConsent: SaveConsent = async (command) => {
	const r = await savePipelineConsent(command);
	if (r.reply.status === "refused") throw new Refusal(r.reply.code);
	return r.consent;
};
export const readSharing: ReadSharing = loadSharing;
export const saveSharingChoice: SaveSharing = async (command) => {
	const r = await saveSharing(command);
	if (r.reply.status === "refused") throw new Refusal(r.reply.code);
	return r.row;
};

export const realRun: Run = async <K extends OperationName>(operation: K, input: Ops[K]["input"]) => {
	const action: Actions[K] = ACTIONS[operation];
	if (!action) throw new Refusal("unavailable");
	const reply = await action(input);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return reply.value;
};

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
		return { history: r.history, pending: r.pending, sharing: r.sharing };
	};
	const readMore: ReadHistory = async (after) => {
		const r = await loadHistoryPage(after);
		learn(r.names);
		return r.page;
	};
	const readDisclosure: ReadDisclosure = (pair) => loadDisclosure(pair);
	const end: EndConnection = async (command) => {
		const r = await endConnection(command);
		if (r.reply.status === "refused") throw new Refusal(r.reply.code);
		if (!r.history) return null;
		learn(r.history.names);
		return r.history.page;
	};
	return { nameOf, learn, load, readMore, readDisclosure, end };
}
