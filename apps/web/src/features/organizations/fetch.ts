import { readsFrom, type ReadResult } from "../../components/get-reads.ts";
import type { RelationshipPair } from "./port";
import type { GET } from "./read.ts";
import { FailedRead } from "../../components/read-failed.ts";

const get = readsFrom<typeof GET>("/connections/read");

async function value<T>(read: Promise<ReadResult<{ status: "ok"; value: T }, string>>): Promise<T> {
	const r = await read;
	if (r.status === "failed") throw new FailedRead("connections");
	if (r.status !== "ok") throw new Error(`connections read ${r.status}`);
	return r.value;
}

export const loadConnections = () => value(get("connections"));
export const loadHistoryPage = (after: string | null) => value(get("history", { after }));
export const loadDisclosure = (pair: RelationshipPair) => value(get("disclosure", pair));
export const loadResidency = (linkId: string) => value(get("residency", { linkId }));
export const loadPipelineConsent = (relationshipId: string) => value(get("consent", { relationshipId }));
export const loadSharing = (relationshipId: string, request: { organization: { id: string } }) =>
	value(get("sharing", { relationshipId, organizationId: request.organization.id }));
