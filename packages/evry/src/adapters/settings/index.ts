import { ACCOUNT_READS } from "../account/reads/index.ts";
import { ACCOUNT_COMMANDS } from "../account/commands/index.ts";
import { SEAT_READS } from "../identity/reads/index.ts";
import { SEAT_COMMANDS } from "../identity/commands/index.ts";
import { PROFILE_READS } from "../organization/reads/index.ts";
import { ORGANIZATION_COMMANDS } from "../organization/commands/index.ts";
import { CONNECTION_READS } from "../relationships/reads/index.ts";
import { RELATIONSHIP_COMMANDS } from "../relationships/commands/index.ts";
import { SHARING_READS } from "../sharing/reads/index.ts";
import { SHARING_COMMANDS } from "../sharing/commands/index.ts";
import { CHURCH_COMMANDS } from "./commands/index.ts";
import { SETTINGS_READS as SECTION_READS } from "./reads/index.ts";

export { CONNECTION_READS, SEAT_READS, SHARING_READS };
export const SETTINGS_READS = [...SECTION_READS, ...PROFILE_READS, ...ACCOUNT_READS] as const;
export const SETTINGS_COMMANDS = {
	...SEAT_COMMANDS,
	...CHURCH_COMMANDS,
	...SHARING_COMMANDS,
	...RELATIONSHIP_COMMANDS,
	...ACCOUNT_COMMANDS,
	...ORGANIZATION_COMMANDS,
} as const;
