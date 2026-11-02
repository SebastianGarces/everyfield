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

/** The notice every formal or legal document prints, in the PDF, the Word file and the editor. */
export const LEGAL_NOTICE = "Template, not legal advice";
