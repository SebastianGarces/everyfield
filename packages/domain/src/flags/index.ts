import "server-only";
export { registry, type FlagDeclaration, type FlagName } from "./registry.ts";
export { GLOBAL_TENANT, readFlags, setFlag } from "./values.ts";
export { logRefusal, readSwitches, switchedOff, type KillSwitch, type Switches } from "./switches.ts";
