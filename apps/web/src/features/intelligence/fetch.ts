import { getReads, refusalAs } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/me/check-in/read");
const lost = () => ({ status: "lost" }) as const;

export const readCheckInHistory = (page: number) => refusalAs(get("history", { page }), lost);
export const reloadAttestations = () => refusalAs(get("attestations"), lost);
export const resolveAssessmentCitation = (runId: string, key: string) =>
	refusalAs(get("citation", { runId, key }), lost);
