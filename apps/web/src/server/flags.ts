import "server-only";
import type { RequestActor } from "@everyfield/domain/access";
import { readFlags, registry, type FlagName } from "@everyfield/domain/flags";
import { flag } from "flags/next";
import { cache } from "react";
import { requestDatabase } from "./database";
import { getViewer } from "./request-context";

type Entities = RequestActor | null;

const requestFlags = cache((authority: Entities) => {
	const db = requestDatabase();
	if (!db) throw Error("flags_database_unavailable");
	return readFlags(db, authority);
});

const adapter = {
	config: { reportValue: false },
	async decide({ key, entities }: { key: string; entities?: Entities }) {
		return (await requestFlags(entities ?? null)).value(key as FlagName);
	},
};

const identify = async (): Promise<Entities> => (await getViewer())?.authority ?? null;

const declare = (key: FlagName) =>
	flag<boolean, Entities>({ key, defaultValue: registry[key].default, adapter, identify });

const flags = Object.fromEntries(Object.keys(registry).map((key) => [key, declare(key as FlagName)])) as {
	[N in FlagName]: ReturnType<typeof declare>;
};

export function readFlag(name: FlagName): Promise<boolean> {
	return flags[name]();
}
