import "server-only";
export { registry, type FlagDeclaration, type FlagName, type Registry } from "./registry.ts";
export { GLOBAL_TENANT, readFlags, setFlag, type FlagScope } from "./values.ts";
export { readAccountIdByEmail, readGlobalValues, readOverrides, readStaleReleaseFlags } from "./operations.ts";
export {
	logRefusal,
	mailDelay,
	readSwitches,
	switchedOff,
	type KillSwitch,
	type MailDelay,
	type Switches,
} from "./switches.ts";
