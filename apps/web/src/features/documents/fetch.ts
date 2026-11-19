import { getReads } from "../../components/get-reads.ts";
import type { Format } from "./model.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/documents/read");

export const resolveDocument = (templateId: string, format: Format) => get("resolved", { templateId, format });
export const listSavedDocuments = () => get("saved");
export const loadWrittenDocuments = () => get("written");
export const loadCopySources = () => get("sources");
export const listChurchTemplates = () => get("templates");
export async function compareWithTemplate(documentId: string) {
	const r = await get("compare", { documentId });
	return r.status === "refused" && !("message" in r) ? ({ status: "lost" } as const) : r;
}
