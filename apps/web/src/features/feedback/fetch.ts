import type { FeedbackCategory, FeedbackStatus } from "@everyfield/contracts/feedback";
import { readsFrom } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/feedback/read");

export const loadSendContext = () => get("context");
export const loadOwnFeedback = (cursor: string) => get("own", { cursor });
export const loadTriage = (filter: {
	status: FeedbackStatus | null;
	category: FeedbackCategory | null;
	cursor: string;
}) => get("triage", filter);
