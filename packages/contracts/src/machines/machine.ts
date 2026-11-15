type OneOrMany<T extends string> = T | readonly T[];

type Guarded<G extends string> = { readonly when?: OneOrMany<G>; readonly unless?: OneOrMany<G> };

export type Edge<S extends string, E extends string, G extends string> = Guarded<G> & {
	readonly event: E;
	readonly from: OneOrMany<S>;
	readonly to: OneOrMany<S>;
	readonly sweep?: true;
	readonly sql?: string;
};

export type Initial<S extends string, E extends string, G extends string> = Guarded<G> & {
	readonly event: E;
	readonly to: OneOrMany<S>;
};

export type Stay<S extends string, E extends string, G extends string> = Guarded<G> & {
	readonly event: E;
	readonly in: readonly S[];
};

export type Transition<S extends string = string, E extends string = string, G extends string = string> = Guarded<G> & {
	readonly event: E;
	readonly from: S;
	readonly to: S;
	readonly sweep?: true;
	readonly sql?: string;
};

export type RefusalCode<S extends string, E extends string, R extends string> = {
	readonly event: E;
	readonly from?: OneOrMany<S>;
	readonly code: R;
};

export type MachineDefinition<S extends string, E extends string, G extends string, Subject, R extends string> = {
	readonly id: string;
	readonly table: string;
	readonly column: string;
	readonly states: readonly S[];
	readonly events: readonly E[];
	readonly refusal: R;
	readonly refusalCodes?: readonly RefusalCode<NoInfer<S>, NoInfer<E>, R>[];
	readonly initial: readonly Initial<NoInfer<S>, NoInfer<E>, NoInfer<G>>[];
	readonly guards: { readonly [K in G]: (subject: Subject) => boolean };
	readonly facts?: readonly NoInfer<G>[];
	readonly subjects: Readonly<Record<string, Subject>>;
	readonly edges: readonly Edge<NoInfer<S>, NoInfer<E>, NoInfer<G>>[];
	readonly stays: readonly Stay<NoInfer<S>, NoInfer<E>, NoInfer<G>>[];
	readonly unchangedIsNoop: readonly NoInfer<E>[];
	readonly decided?: readonly NoInfer<E>[];
	readonly notes?: readonly string[];
	readonly proof: string;
};

export type Machine<
	S extends string,
	E extends string,
	G extends string,
	Subject,
	R extends string,
> = MachineDefinition<S, E, G, Subject, R> & {
	readonly transitions: readonly Transition<S, E, G>[];
	readonly entries: readonly (Guarded<G> & { readonly event: E; readonly to: S })[];
};

export type MachineShape = {
	readonly id: string;
	readonly table: string;
	readonly column: string;
	readonly states: readonly string[];
	readonly events: readonly string[];
	readonly refusal: string;
	readonly refusalCodes?: readonly RefusalCode<string, string, string>[];
	readonly entries: readonly (Guarded<string> & { readonly event: string; readonly to: string })[];
	readonly guards: { readonly [K in string]: (subject: never) => boolean };
	readonly facts?: readonly string[];
	readonly subjects: Readonly<Record<string, unknown>>;
	readonly transitions: readonly Transition[];
	readonly stays: readonly Stay<string, string, string>[];
	readonly unchangedIsNoop: readonly string[];
	readonly decided?: readonly string[];
	readonly notes?: readonly string[];
	readonly proof: string;
};

const many = <T extends string>(value: OneOrMany<T> | undefined): readonly T[] =>
	value === undefined ? [] : typeof value === "string" ? [value] : value;

const rule = <G extends string>(r: Guarded<G>): Guarded<G> => ({
	...(r.when ? { when: r.when } : {}),
	...(r.unless ? { unless: r.unless } : {}),
});

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
				...rule(edge),
				...(edge.sweep ? { sweep: true as const } : {}),
				...(edge.sql ? { sql: edge.sql } : {}),
			})),
		),
	);
	const entries = definition.initial.flatMap((entry) =>
		many(entry.to).map((to) => ({ event: entry.event, to, ...rule(entry) })),
	);
	return { ...definition, transitions, entries };
}

type Guards = { readonly [K in string]: (subject: never) => boolean };

function applies(guards: Guards, r: Guarded<string>, subject: unknown, ignore: readonly string[] = []): boolean {
	const holds = (g: string) => (guards[g] as (s: unknown) => boolean)(subject);
	return (
		many(r.when).every((g) => ignore.includes(g) || holds(g)) &&
		many(r.unless).every((g) => ignore.includes(g) || !holds(g))
	);
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

export function permits<S extends string, E extends string, G extends string, Subject, R extends string>(
	m: Machine<S, E, G, Subject, R>,
	event: E,
	from: S,
	to: S,
	subject: Subject,
): boolean {
	return from === to && holds(m, event, from, subject) ? true : allows(m, event, from, to, subject);
}

export function enters(m: MachineShape, subject: unknown): readonly { readonly event: string; readonly to: string }[] {
	return m.entries.filter((e) => applies(m.guards, e, subject));
}

export function entryStates(m: MachineShape, event: string): string[] {
	return [...new Set(m.entries.filter((e) => e.event === event).map((e) => e.to))];
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

export function refusalOf(m: MachineShape, event: string, from: string): string {
	return (
		m.refusalCodes?.find((r) => r.event === event && (r.from === undefined || many(r.from).includes(from)))?.code ??
		m.refusal
	);
}

export function reachable(m: MachineShape, subject: unknown): readonly string[] {
	const facts = m.facts ?? [];
	const seen = new Set(m.entries.filter((e) => applies(m.guards, e, subject, facts)).map((e) => e.to));
	const queue = [...seen];
	for (let at = queue.shift(); at !== undefined; at = queue.shift())
		for (const t of m.transitions)
			if (t.from === at && !seen.has(t.to) && applies(m.guards, t, subject, facts)) {
				seen.add(t.to);
				queue.push(t.to);
			}
	return m.states.filter((s) => seen.has(s));
}

export type Refusal = {
	readonly subject: string;
	readonly event: string;
	readonly from: string;
	readonly to: string;
	readonly code: string;
};

export type Skip = { readonly subject: string; readonly event: string; readonly from: string; readonly to: string };

function moves(m: MachineShape, sweep: boolean) {
	const facts = m.facts ?? [];
	const found: { subject: string; event: string; from: string; to: string }[] = [];
	for (const [name, subject] of Object.entries(m.subjects)) {
		const states = reachable(m, subject);
		for (const event of m.events) {
			const edges = m.transitions.filter((t) => t.event === event && !!t.sweep === sweep);
			const stays = m.stays.filter((s) => s.event === event);
			const held = (state: string) => stays.some((s) => s.in.includes(state) && applies(m.guards, s, subject));
			const leaves = (state: string) => edges.some((t) => t.from === state && applies(m.guards, t, subject));
			if (m.decided?.includes(event)) {
				if (!sweep && [...edges, ...stays].some((r) => applies(m.guards, r, subject, facts)))
					for (const state of states)
						if (!leaves(state) && !held(state)) found.push({ subject: name, event, from: state, to: state });
				continue;
			}
			if (edges.some((t) => applies(m.guards, t, subject, facts))) {
				const candidates = [...new Set(edges.map((t) => t.to))];
				for (const from of states)
					for (const to of candidates) {
						if (from === to && (m.unchangedIsNoop.includes(event) || held(from))) continue;
						if (!edges.some((t) => t.from === from && t.to === to && applies(m.guards, t, subject)))
							found.push({ subject: name, event, from, to });
					}
			}
			if (sweep) continue;
			if (stays.some((s) => applies(m.guards, s, subject, facts)))
				for (const state of states)
					if (!held(state) && !leaves(state)) found.push({ subject: name, event, from: state, to: state });
		}
	}
	return [...new Map(found.map((f) => [`${f.subject} ${f.event} ${f.from} ${f.to}`, f])).values()];
}

export function refusals(m: MachineShape): readonly Refusal[] {
	return moves(m, false).map((r) => ({ ...r, code: refusalOf(m, r.event, r.from) }));
}

export function skips(m: MachineShape): readonly Skip[] {
	return moves(m, true);
}

export type Noop = { readonly subject: string; readonly event: string; readonly state: string };

export function noops(m: MachineShape): readonly Noop[] {
	return Object.entries(m.subjects).flatMap(([subject, sample]) =>
		m.unchangedIsNoop.flatMap((event) => {
			const targets = new Set(m.transitions.filter((t) => t.event === event).map((t) => t.to));
			return reachable(m, sample)
				.filter((state) => targets.has(state))
				.map((state) => ({ subject, event, state }));
		}),
	);
}

export type Observation = {
	readonly machine: string;
	readonly kind: "edge" | "stay" | "refusal" | "skip" | "noop";
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

export function coverage(m: MachineShape, observations: readonly Observation[]): Coverage {
	const seen = observations.filter((o) => o.machine === m.id);
	const key = (kind: string, event: string, from: string | null, to: string, subject = "") =>
		[kind, subject, event, from ?? "[*]", to].filter(Boolean).join(" ");
	const observed = new Set(
		seen.flatMap((o) => [key(o.kind, o.event, o.from, o.to), key(o.kind, o.event, o.from, o.to, o.subject)]),
	);
	const edges = [
		...m.entries.map((e) => key("edge", e.event, null, e.to)),
		...m.transitions.map((t) => key("edge", t.event, t.from, t.to)),
	];
	const stays = m.stays.flatMap((s) => s.in.map((state) => key("stay", s.event, state, state)));
	const refused = refusals(m).map((r) => key("refusal", r.event, r.from, r.to, r.subject));
	const skipped = skips(m).map((r) => key("skip", r.event, r.from, r.to, r.subject));
	const unchanged = noops(m).map((n) => key("noop", n.event, n.state, n.state, n.subject));
	const states = m.states.filter((s) => seen.some((o) => (o.kind === "edge" || o.kind === "stay") && o.to === s));
	const count = (keys: readonly string[]) => {
		const all = [...new Set(keys)];
		return { all, hit: all.filter((k) => observed.has(k)) };
	};
	const e = count(edges),
		st = count(stays),
		r = count(refused),
		sk = count(skipped),
		n = count(unchanged);
	const missing = [
		...[...e.all, ...st.all, ...r.all, ...sk.all, ...n.all].filter((k) => !observed.has(k)),
		...m.states.filter((s) => !states.includes(s)).map((s) => `state ${s}`),
	];
	const part = (name: string, c: { all: readonly string[]; hit: readonly string[] }) =>
		`${name} ${c.hit.length}/${c.all.length}`;
	const line =
		`${m.id}: ${part("edges", e)}, ${part("stays", st)}, ${part("refusals", r)}, ` +
		(sk.all.length ? `${part("skips", sk)}, ` : "") +
		`${part("no-ops", n)}, states ${states.length}/${m.states.length}`;
	return { line, complete: missing.length === 0, missing };
}

const guardText = (t: Guarded<string>) =>
	[t.when ? `when ${many(t.when).join(" and ")}` : "", t.unless ? `unless ${many(t.unless).join(" or ")}` : ""]
		.filter(Boolean)
		.join(", ");

export function mermaid(m: MachineShape): string {
	const label = (event: string, r: Guarded<string> & { readonly sweep?: true; readonly sql?: string }) =>
		[event, r.sweep ? "sweep" : "", guardText(r), r.sql ? `via ${r.sql}` : ""].filter(Boolean).join(" ");
	const arrows = new Map<string, string[]>();
	const arrow = (pair: string, text: string) => arrows.set(pair, [...(arrows.get(pair) ?? []), text]);
	for (const e of m.entries) arrow(`[*] --> ${e.to}`, label(e.event, e));
	for (const t of m.transitions) arrow(`${t.from} --> ${t.to}`, label(t.event, t));
	return [
		"stateDiagram-v2",
		...[...arrows].map(([pair, labels]) => `  ${pair}: ${labels.join(" / ")}`),
		...m.stays.flatMap((s) => s.in.map((state) => `  note right of ${state} : stays on ${label(s.event, s)}`)),
	].join("\n");
}

export function unreachableStates(m: MachineShape): readonly string[] {
	const reached = new Set([
		...m.entries.map((e) => e.to),
		...m.transitions.filter((t) => t.from !== t.to).map((t) => t.to),
	]);
	return m.states.filter((s) => !reached.has(s));
}
