import type { FeedbackCategory, FeedbackStatus } from "@everyfield/contracts/feedback";
import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/feedback/read");

export const loadSendContext = () => get("context");
export const loadOwnFeedback = (cursor: string) => get("own", { cursor });
export const loadTriage = (filter: {
	status: FeedbackStatus | null;
	category: FeedbackCategory | null;
	cursor: string;
}) => get("triage", filter);
