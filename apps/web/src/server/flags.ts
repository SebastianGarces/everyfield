import "server-only";
import { deploymentKind, isTestDeployment } from "@everyfield/db/deployment";
import type { RequestActor } from "@everyfield/domain/access";
import { readFlags, registry, type FlagName } from "@everyfield/domain/flags";
import { createFlagsDiscoveryEndpoint, flag, getProviderData } from "flags/next";
import { cache } from "react";
import { serverEnv } from "./config";
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

const options = [
	{ value: false, label: "Off" },
	{ value: true, label: "On" },
];

const declare = (key: FlagName) =>
	flag<boolean, Entities>({
		key,
		defaultValue: registry[key].default,
		description: `${registry[key].kind} flag, owner ${registry[key].owner}, ${registry[key].task}, expires ${registry[key].expires}`,
		options,
		adapter,
		identify,
	});

const flags = Object.fromEntries(Object.keys(registry).map((key) => [key, declare(key as FlagName)])) as {
	[N in FlagName]: ReturnType<typeof declare>;
};

const overridesAllowed = (): boolean => {
	const env = serverEnv();
	return isTestDeployment(env) && (Boolean(env.FLAGS_SECRET) || deploymentKind(env) === "preview");
};

const requestWithoutOverrideCookie = cache(() => new Request("http://flags.invalid/"));

export function readFlag(name: FlagName): Promise<boolean> {
	return overridesAllowed() ? flags[name]() : flags[name](requestWithoutOverrideCookie());
}

const discovery = createFlagsDiscoveryEndpoint(() => getProviderData(flags));

export function flagsDiscovery(request: Parameters<typeof discovery>[0]): Promise<Response> {
	if (!overridesAllowed()) return Promise.resolve(new Response(null, { status: 404 }));
	return discovery(request);
}
