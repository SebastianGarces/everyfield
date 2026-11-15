export type OneTimeLinkValue = {
	readonly path: string;
	readonly part: "query" | "fragment";
	readonly param: string | null;
	readonly kept: { readonly key: string; readonly scope: string | null } | null;
};

export const ONE_TIME_LINK_VALUES = {
	"connections/respond": {
		path: "/connections/respond",
		part: "fragment",
		param: null,
		kept: { key: "ef-relationship-proof", scope: "invitation" },
	},
	invitation: {
		path: "/invitation",
		part: "fragment",
		param: "proof",
		kept: { key: "ef-invitation-proof", scope: null },
	},
	"reset-password": { path: "/reset-password", part: "query", param: "token", kept: null },
	"verify-email": { path: "/verify-email", part: "query", param: "token", kept: null },
} as const satisfies Record<string, OneTimeLinkValue>;

export type OneTimeLinkName = keyof typeof ONE_TIME_LINK_VALUES;

export type LinkWindow = {
	readonly location: { readonly pathname: string; readonly search: string; readonly hash: string };
	readonly history: { readonly state: unknown; replaceState(state: unknown, unused: string, url: string): void };
	readonly sessionStorage: { setItem(key: string, value: string): void };
};

export type LinkValueAt = { readonly name: string; readonly key: string | null; readonly value: string | null };

export function oneTimeLinkValue(
	values: Readonly<Record<string, OneTimeLinkValue>>,
	w: LinkWindow,
	take: boolean,
): LinkValueAt | null {
	const pathname = w.location.pathname;
	for (const name of Object.keys(values)) {
		const entry = values[name];
		if (!entry || entry.path !== pathname) continue;
		const query = new URLSearchParams(w.location.search);
		const fragment = w.location.hash.slice(1);
		const key = entry.kept && entry.kept.key + (entry.kept.scope === null ? "" : "/" + query.get(entry.kept.scope));
		const value =
			entry.part === "query"
				? query.get(entry.param ?? "")
				: entry.param === null
					? fragment || null
					: new URLSearchParams(fragment).get(entry.param);
		if (!take || !value) return { name, key, value };
		if (entry.part === "query") query.delete(entry.param ?? "");
		const rest = query.toString();
		const clean = pathname + (rest ? "?" + rest : "") + (entry.part === "query" ? w.location.hash : "");
		try {
			if (key !== null) w.sessionStorage.setItem(key, value);
		} finally {
			w.history.replaceState(w.history.state, "", clean);
		}
		return { name, key, value };
	}
	return null;
}

export const ONE_TIME_LINK_SCRIPT = `(${oneTimeLinkValue.toString()})(${JSON.stringify(ONE_TIME_LINK_VALUES)},window,true)`;
