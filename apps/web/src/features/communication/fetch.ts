import type { historyQuery } from "@everyfield/contracts/communication";
import type { z } from "zod";
import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/communication/read");

export const searchRecipients = (query: string) => get("recipients", query);
export const readDraft = (communicationId: string) => get("draft", { communicationId });
export const readMeetingTemplate = (meetingType: string) => get("template", { meetingType });
export const readOwnSuppression = () => get("suppression");
export const readHistory = (query: z.input<typeof historyQuery>) => get("history", query);
export const readPersonHistory = (personId: string, cursor?: string) =>
	get("person", { personId, ...(cursor ? { cursor } : {}) });
export const readMeetingHistory = (meetingId: string, cursor?: string) =>
	get("meeting", { meetingId, ...(cursor ? { cursor } : {}) });
export const readMeetingTracking = (meetingId: string) => get("tracking", { meetingId });
export const readMeetingContext = (meetingId: string) => get("context", { meetingId });
export const readPreviewContext = () => get("preview");
