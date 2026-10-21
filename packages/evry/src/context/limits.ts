/** The frozen runtime limits from the Evry chapter's finite runtime contract. Changing one changes the contract. */
export const LIMITS = {
	toolCalls: 24,
	outputTokensPerCall: 8_000,
	inputTokens: 128_000,
	outputTokens: 16_000,
	wallMs: 180_000,
	readTimeoutMs: 30_000,
	readRetries: 1,
	modelRetryDelaysMs: [1_000, 3_000],
	recentMessages: 24,
	contextTokens: 32_000,
	references: 64,
	sectionChars: 16_000,
	selectedRows: 24,
} as const;

/** Why a turn stopped. Every value except "completed" says a limit or a choice ended the turn early. */
export type StopReason =
	| "completed"
	| "policy_boundary"
	| "tool_budget"
	| "input_budget"
	| "output_budget"
	| "wall_time"
	| "cancelled"
	| "failed";
