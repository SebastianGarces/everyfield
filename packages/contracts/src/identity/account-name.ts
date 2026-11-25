import type { OrganizationKind } from "../common/values.ts";

const ACCOUNT_NAME = {
	plant: "church plant account",
	sending_church: "sending church account",
	sending_network: "network account",
} as const;

export function accountName(kind: "plant" | OrganizationKind): string {
	return ACCOUNT_NAME[kind];
}
