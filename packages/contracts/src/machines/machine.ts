type OneOrMany<T extends string> = T | readonly T[];

export type Edge<S extends string, E extends string, G extends string> = {
	readonly event: E;
	readonly from: OneOrMany<S>;
	readonly to: OneOrMany<S>;
	readonly when?: G;
	readonly unless?: G;
};

export type Stay<S extends string, E extends string, G extends string> = {
	readonly event: E;
	readonly in: readonly S[];
	readonly when?: G;
	readonly unless?: G;
};

export type Transition<S extends string = string, E extends string = string, G extends string = string> = {
	readonly event: E;
	readonly from: S;
	readonly to: S;
	readonly when?: G;
	readonly unless?: G;
};

export type MachineDefinition<S extends string, E extends string, G extends string, Subject, R extends string> = {
	readonly id: string;
	readonly table: string;
	readonly column: string;
	readonly states: readonly S[];
	readonly events: readonly E[];
	readonly refusal: R;
	readonly initial: { readonly event: NoInfer<E>; readonly to: NoInfer<S> };
	readonly guards: { readonly [K in G]: (subject: Subject) => boolean };
	readonly subjects: Readonly<Record<string, Subject>>;
	readonly edges: readonly Edge<NoInfer<S>, NoInfer<E>, NoInfer<G>>[];
	readonly stays: readonly Stay<NoInfer<S>, NoInfer<E>, NoInfer<G>>[];
	readonly unchangedIsNoop: readonly NoInfer<E>[];
	readonly proof: string;
};

export type Machine<
	S extends string,
	E extends string,
	G extends string,
	Subject,
	R extends string,
> = MachineDefinition<S, E, G, Subject, R> & { readonly transitions: readonly Transition<S, E, G>[] };

export type MachineShape = {
	readonly id: string;
	readonly table: string;
	readonly column: string;
	readonly states: readonly string[];
	readonly events: readonly string[];
	readonly refusal: string;
	readonly initial: { readonly event: string; readonly to: string };
	readonly subjects: Readonly<Record<string, unknown>>;
	readonly transitions: readonly Transition[];
	readonly stays: readonly Stay<string, string, string>[];
	readonly unchangedIsNoop: readonly string[];
	readonly proof: string;
};

const many = <T extends string>(value: OneOrMany<T>): readonly T[] => (typeof value === "string" ? [value] : value);

export function machine<
	const S extends string,
	const E extends string,
	G extends string,
	Subject,
	const R extends string,
>(definition: MachineDefinition<S, E, G, Subject, R>): Machine<S, E, G, Subject, R> {
	const transitions = definition.edges.flatMap((edge) =>
		many(edge.from).flatMap((from) =>
			many(edge.to).map((to) => ({
				event: edge.event,
				from,
				to,
				...(edge.when ? { when: edge.when } : {}),
				...(edge.unless ? { unless: edge.unless } : {}),
			})),
		),
	);
	return { ...definition, transitions };
}

type Guarded<G extends string> = { readonly when?: G; readonly unless?: G };

function applies<G extends string, Subject>(
	guards: { readonly [K in G]: (subject: Subject) => boolean },
	rule: Guarded<G>,
	subject: Subject,
): boolean {
	return (!rule.when || guards[rule.when](subject)) && (!rule.unless || !guards[rule.unless](subject));
}

export function allows<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
	event: E,
	from: S,
	to: S,
	subject: Subject,
): boolean {
	return m.transitions.some(
		(t) => t.event === event && t.from === from && t.to === to && applies(m.guards, t, subject),
	);
}

export function holds<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
	event: E,
	state: S,
	subject: Subject,
): boolean {
	return m.stays.some((s) => s.event === event && s.in.includes(state) && applies(m.guards, s, subject));
}

export function targets<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
	event: E,
	from: S,
	subject: Subject,
): readonly S[] {
	const found = m.transitions.filter((t) => t.event === event && t.from === from && applies(m.guards, t, subject));
	return [...new Set(found.map((t) => t.to))];
}

export function fromStates<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
	event: E,
	to: S,
	subject: Subject,
): S[] {
	const found = m.transitions.filter((t) => t.event === event && t.to === to && applies(m.guards, t, subject));
	return [...new Set(found.map((t) => t.from))];
}

export type Refusal = { readonly subject: string; readonly event: string; readonly from: string; readonly to: string };

export function refusals<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
): readonly Refusal[] {
	const found: Refusal[] = [];
	for (const [name, subject] of Object.entries(m.subjects)) {
		for (const event of m.events) {
			const moves = m.transitions.filter((t) => t.event === event);
			if (moves.some((t) => applies(m.guards, t, subject))) {
				const candidates = [...new Set(moves.map((t) => t.to))];
				for (const from of m.states)
					for (const to of candidates) {
						if (from === to && m.unchangedIsNoop.includes(event)) continue;
						if (!allows(m, event, from, to, subject)) found.push({ subject: name, event, from, to });
					}
			}
			const stays = m.stays.filter((s) => s.event === event && applies(m.guards, s, subject));
			if (stays.length)
				for (const state of m.states)
					if (!holds(m, event, state, subject)) found.push({ subject: name, event, from: state, to: state });
		}
	}
	return found;
}

export type Observation = {
	readonly machine: string;
	readonly kind: "edge" | "stay" | "refusal";
	readonly subject: string;
	readonly event: string;
	readonly from: string | null;
	readonly to: string;
};

export type Coverage = {
	readonly line: string;
	readonly complete: boolean;
	readonly missing: readonly string[];
};

export function coverage(
	m: MachineShape,
	declaredRefusals: readonly Refusal[],
	observations: readonly Observation[],
): Coverage {
	const seen = observations.filter((o) => o.machine === m.id);
	const key = (kind: string, event: string, from: string | null, to: string, subject = "") =>
		[kind, subject, event, from ?? "[*]", to].filter(Boolean).join(" ");
	const observed = new Set(
		seen.flatMap((o) => [key(o.kind, o.event, o.from, o.to), key(o.kind, o.event, o.from, o.to, o.subject)]),
	);
	const edges = [
		key("edge", m.initial.event, null, m.initial.to),
		...m.transitions.map((t) => key("edge", t.event, t.from, t.to)),
	];
	const stays = m.stays.flatMap((s) => s.in.map((state) => key("stay", s.event, state, state)));
	const refused = declaredRefusals.map((r) => key("refusal", r.event, r.from, r.to, r.subject));
	const states = m.states.filter((s) => seen.some((o) => o.kind !== "refusal" && o.to === s));
	const unique = (keys: readonly string[]) => [...new Set(keys)];
	const count = (keys: readonly string[]) => {
		const all = unique(keys);
		return { all, hit: all.filter((k) => observed.has(k)) };
	};
	const e = count(edges),
		st = count(stays),
		r = count(refused);
	const missing = [
		...[...e.all, ...st.all, ...r.all].filter((k) => !observed.has(k)),
		...m.states.filter((s) => !states.includes(s)).map((s) => `state ${s}`),
	];
	const line =
		`${m.id}: edges ${e.hit.length}/${e.all.length}, stays ${st.hit.length}/${st.all.length}, ` +
		`refusals ${r.hit.length}/${r.all.length}, states ${states.length}/${m.states.length}`;
	return { line, complete: missing.length === 0, missing };
}

const guardText = (t: Guarded<string>) =>
	[t.when ? `when ${t.when}` : "", t.unless ? `unless ${t.unless}` : ""].filter(Boolean).join(", ");

export function mermaid(m: MachineShape): string {
	const label = (event: string, rule: Guarded<string>) => [event, guardText(rule)].filter(Boolean).join(" ");
	return [
		"stateDiagram-v2",
		`  [*] --> ${m.initial.to}: ${m.initial.event}`,
		...m.transitions.map((t) => `  ${t.from} --> ${t.to}: ${label(t.event, t)}`),
		...m.stays.flatMap((s) => s.in.map((state) => `  note right of ${state}: stays on ${label(s.event, s)}`)),
	].join("\n");
}

export function unreachableStates(m: MachineShape): readonly string[] {
	const reached = new Set([m.initial.to, ...m.transitions.filter((t) => t.from !== t.to).map((t) => t.to)]);
	return m.states.filter((s) => !reached.has(s));
}
