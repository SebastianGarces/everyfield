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
import type { NameOf, Run } from "./port";
import type { ReadResidency } from "./Residency";
import type { ReadSharing } from "./Sharing";

// The real port (WP-007/ui ruling D11): one typed server action per operation. The server parses the browser's input
// and answers with the contract value, which the screens trust. A server refusal becomes a Refusal; a lost reply stays
// a thrown network error, so useIntent keeps the command frozen.

export const readResidency: ReadResidency = loadResidency;
export const readSharing: ReadSharing = loadSharing;

export const realRun = (async (operation, input) => {
	const reply = await runOrganizationOperation(operation, input);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return reply.value;
}) as Run;

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
		return { history: r.history, pending: r.pending };
	};
	const readMore: ReadHistory = async (after) => {
		const r = await loadHistoryPage(after);
		learn(r.names);
		return r.page;
	};
	const readDisclosure: ReadDisclosure = (pair) => loadDisclosure(pair);
	return { nameOf, learn, load, readMore, readDisclosure };
}
