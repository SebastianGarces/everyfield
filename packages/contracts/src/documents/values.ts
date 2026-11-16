import { z } from "zod";

export const templateId = z.string().trim().min(1).max(80);
export const documentFormat = z.enum(["pdf", "docx", "xlsx"]);
export const documentCategory = z.enum(["commitment", "vision_meeting", "administrative", "operational"]);
export const MERGE_VALUE_MAX = 2000;
export const MERGE_BYTES_MAX = 16 * 1024;
export const MERGE_KEY_MAX = 20;

export const IMPORT_BYTES_MAX = 10 * 1024 * 1024;
export const IMPORT_TOO_LARGE = `The file must be ${IMPORT_BYTES_MAX / (1024 * 1024)} MB or smaller.`;

export const LEGAL_NOTICE = "Template, not legal advice";

export const churchTemplateKey = (recordId: string) => `church-${recordId}`;
const CHURCH_TEMPLATE_KEY = /^church-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const churchTemplateRecord = (templateId: string) => CHURCH_TEMPLATE_KEY.exec(templateId)?.[1] ?? null;
