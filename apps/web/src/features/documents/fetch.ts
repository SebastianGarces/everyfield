import { getReads, refusalAs } from "../../components/get-reads.ts";
import type { Format } from "./model.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/documents/read");

export const resolveDocument = (templateId: string, format: Format) => get("resolved", { templateId, format });
export const listSavedDocuments = () => get("saved");
export const loadWrittenDocuments = () => get("written");
export const loadCopySources = () => get("sources");
export const listChurchTemplates = () => get("templates");
export const compareWithTemplate = (documentId: string) =>
	refusalAs(get("compare", { documentId }), () => ({ status: "lost" }) as const);
export const downloadSavedDocument = (documentId: string) => get("download", { documentId });
