import { ACCOUNT_COMMANDS } from "../account/commands/index.ts";
import { SEAT_READS } from "../identity/reads/index.ts";
import { SEAT_COMMANDS } from "../identity/commands/index.ts";
import { ORGANIZATION_COMMANDS } from "../organization/commands/index.ts";
import { RELATIONSHIP_COMMANDS } from "../relationships/commands/index.ts";
import { SHARING_READS } from "../sharing/reads/index.ts";
import { SHARING_COMMANDS } from "../sharing/commands/index.ts";
import { CHURCH_COMMANDS } from "./commands/index.ts";

// The seat, Settings, sharing, connection, account and organization tools (T-327), gathered for the catalog and the
// reviewed-write registry.

export { SEAT_READS, SHARING_READS };
export const SETTINGS_COMMANDS = {
	...SEAT_COMMANDS,
	...CHURCH_COMMANDS,
	...SHARING_COMMANDS,
	...RELATIONSHIP_COMMANDS,
	...ACCOUNT_COMMANDS,
	...ORGANIZATION_COMMANDS,
} as const;
