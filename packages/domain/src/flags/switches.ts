import { asLogWord, logLine, type LogWord } from "../log.ts";
import { registry, type FlagName } from "./registry.ts";
import { readFlags } from "./values.ts";

type Db = Parameters<typeof readFlags>[0];

export type KillSwitch = { [N in FlagName]: (typeof registry)[N]["kind"] extends "kill" ? N : never }[FlagName];
export type Switches = { readonly [N in KillSwitch]: boolean };

const KILL_SWITCHES = (Object.keys(registry) as FlagName[]).filter(
	(name): name is KillSwitch => registry[name].kind === "kill",
);

export async function readSwitches(db: Db): Promise<Switches> {
	const values = await readFlags(db, null);
	return Object.fromEntries(KILL_SWITCHES.map((name) => [name, values.value(name)])) as Switches;
}

type Action<A> = LogWord<A> | ReturnType<typeof asLogWord>;

export function logRefusal<const A extends string>(name: KillSwitch, action: Action<A>): void {
	logLine({ component: "kill-switch", switch: name, action, outcome: "refused" });
}

export function switchedOff<const A extends string>(switches: Switches, name: KillSwitch, action: Action<A>): boolean {
	if (switches[name]) return false;
	logRefusal(name, action);
	return true;
}
