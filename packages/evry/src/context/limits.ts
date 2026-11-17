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

export type StopReason =
	| "completed"
	| "policy_boundary"
	| "tool_budget"
	| "input_budget"
	| "output_budget"
	| "wall_time"
	| "cancelled"
	| "failed";
