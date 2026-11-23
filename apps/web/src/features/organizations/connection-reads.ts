import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import "server-only";
import {
	disclosureFor,
	idsIn,
	namesFor,
	pendingFor,
	readHistory,
	readPipelineConsents,
	readPlantSharing,
	residencyLinks,
	scopeOf,
	viewerOf,
} from "./mount";
import type { ResidencyRow } from "./Residency";

type Who = Extract<Awaited<ReturnType<typeof viewerOf>>, { kind: "viewer" }>;

export async function who(): Promise<Who | null> {
	const w = await viewerOf();
	return w.kind === "viewer" ? w : null;
}

export async function loadHistoryPage(w: Who | null, after: string | null) {
	if (!w) return { page: { status: "unavailable" as const }, names: {} };
	const page = await readHistory(w.mount.db, w.authority, { ...scopeOf(w.viewer), ...(after ? { after } : {}) });
	const names = page.status === "available" ? await namesFor(w.mount.db, w.viewer, idsIn(page)) : {};
	return { page, names };
}

export async function loadConnections(w: Who | null) {
	if (!w) return { history: { status: "unavailable" as const }, pending: [], sharing: {}, names: {} };
	const [first, pending, sharing] = await Promise.all([
		loadHistoryPage(w, null),
		pendingFor(w.mount.db, w.viewer),
		readPlantSharing(w.mount.db, w.authority),
	]);
	const extra = await namesFor(
		w.mount.db,
		w.viewer,
		pending.map((p) => p.pair.organization.id),
	);
	return { history: first.page, pending, sharing, names: { ...first.names, ...extra } };
}

export async function loadDisclosure(w: Who | null, pair: unknown) {
	if (!w) return null;
	return disclosureFor(w.mount, w.authority, w.viewer, pair);
}

export async function loadResidency(w: Who | null, linkId: string): Promise<ResidencyRow> {
	const [link] = w ? await residencyLinks(w.mount.db, w.viewer, linkId) : [];
	return link ?? { sharing: { status: "unavailable" as const }, linkRevision: "0" };
}

export async function loadPipelineConsent(
	w: Who | null,
	relationshipId: string,
): Promise<Ops["pipelineSharing.readConsent"]["output"]> {
	const [row] = w ? await readPipelineConsents(w.mount.db, w.authority, relationshipId) : [];
	return row?.consent ?? { status: "unavailable" as const };
}

export async function loadSharing(
	w: Who | null,
	relationshipId: string,
	organizationId: string,
): Promise<{ sharing: Ops["privacy.getSharing"]["output"]; relationshipRevision: string }> {
	const row = w ? (await readPlantSharing(w.mount.db, w.authority, organizationId))[relationshipId] : null;
	return row ?? { sharing: { status: "unavailable" as const }, relationshipRevision: "0" };
}
