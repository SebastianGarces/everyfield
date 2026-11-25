const ACCOUNT_NAME = {
	plant: "church plant account",
	sending_church: "sending church account",
	sending_network: "network account",
} as const;

export function accountName(kind: keyof typeof ACCOUNT_NAME): string {
	return ACCOUNT_NAME[kind];
}
