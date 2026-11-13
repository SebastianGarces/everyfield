import { z } from "zod";

export const templateId = z.string().trim().min(1).max(80);
export const documentFormat = z.enum(["pdf", "docx", "xlsx"]);
export const documentCategory = z.enum(["commitment", "vision_meeting", "administrative", "operational"]);
/** One merge value. The catalog field labels are shorter than this cap. */
export const MERGE_VALUE_MAX = 2000;
/** Combined UTF-8 size of the raw override values. */
export const MERGE_BYTES_MAX = 16 * 1024;
/** Keys accepted on one override map before the catalog check. */
export const MERGE_KEY_MAX = 20;

/**
 * The largest .txt or .docx file a written document imports, in bytes. The browser check, the import route,
 * the request contract and the domain read this one number, and the host must accept a body this size.
 */
export const IMPORT_BYTES_MAX = 10 * 1024 * 1024;
/** The limit as people read it: "10 MB". */
export const IMPORT_TOO_LARGE = `The file must be ${IMPORT_BYTES_MAX / (1024 * 1024)} MB or smaller.`;

/** The notice every formal or legal document prints, in the PDF, the Word file and the editor. */
export const LEGAL_NOTICE = "Template, not legal advice";

/**
 * A church template's id in "New from template" and in a document made from it: "church-" and the template's record
 * id. A built-in template id never starts with "church-".
 */
export const churchTemplateKey = (recordId: string) => `church-${recordId}`;
const CHURCH_TEMPLATE_KEY = /^church-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The record id a church template id names, or null for a built-in template id. */
export const churchTemplateRecord = (templateId: string) => CHURCH_TEMPLATE_KEY.exec(templateId)?.[1] ?? null;
