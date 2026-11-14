import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { dayText } from "../adapters/pipeline/reads/index.ts";
import { PIPELINE_RULES } from "../context/compile.ts";

// The scripted model's pipeline and program requests (WP-101), for local previews and tests only. It answers through
// the same tools a model gets: it reads the pipeline as the user's Pipeline page shows it, drafts a program plan, and
// proposes a stage move or a program that the user reviews. A request the tools never serve (logging a conversation,
// reading notes, ranking people) gets the product's own reply from the system prompt (compile.ts), quoted only when the
// prompt holds it, so the evals test the text the real model is given.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { rows?: Row[]; facts?: Record<string, unknown> };

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];

function turnOutputs(prompt: Prompt): Output[] {
	const start = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");

const LOG = /\b(?:log|record|add|write)\b.*\b(?:conversation|call|note|assessment|milestone)s?\b/i;
const JUDGE = /\b(?:notes?|feedback|rank|ranking|most ready|ready to plant|best (?:fit|candidate)|calling)\b/i;
const OTHER_PIPELINE = /\b([A-Z][\w-]*(?: [A-Z][\w-]*)*)'s pipeline\b/;
const NAMED = /\b(?:where is|where's|has|is|about|show me|find)\s+([A-Z][a-z]+)\b/;
const STALE = /\b(?:hasn'?t|has not|haven'?t|have not|not) moved\b|\bno (?:stage )?move\b|\bsix months\b/i;
const PIPELINE = /\bpipeline\b|\bby stage\b/i;
const MOVE =
	/\bmove ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?) to (?:the )?([A-Za-z][\w ]*?)(?: stage)?(?:\s+because\b.*)?[.!]?\s*$/i;
const DRAFT =
	/\bdraft (?:a |an )?(\d{1,3})[- ]month (apprenticeship|residency)(?: program)? plan(?: with ([A-Z][a-z]+) as (?:the )?director)?/i;

const NEXT = /\bdraft (?:a |the )?next version of (.+?)(?::\s*([\s\S]*))?$/i;
const PUBLISH = /\b(?:publish|enroll|apply)\b.*\b(?:version|program|residency|apprenticeship|plan)\b/i;
const SHOW_PROGRAM =
	/\b(?:show(?: me)?|what(?:'s| is| does)|tell me about)\s+(?:about\s+)?(.*?\b(?:residency|apprenticeship|program))\b/i;
const QUOTED = `["'\u2018\u201c]([^"'\u2019\u201d]+)["'\u2019\u201d]`;
const RHYTHM_TEXT = { weekly: "weekly", every_two_weeks: "every two weeks", monthly: "monthly" } as const;
type Rhythm = keyof typeof RHYTHM_TEXT;

/** The program a request names ("the residency", "our apprenticeship"), among the programs read. */
function programNamed(rows: Row[], hint: string) {
	const words = hint
		.toLowerCase()
		.split(/[^a-z0-9-]+/)
		.filter((w) => w && !["the", "our", "my", "a", "of", "program", "plan"].includes(w));
	return rows.find((r) => words.every((w) => r.label.toLowerCase().includes(w) || r.fields.kind === w));
}
/** The organization a request names as the program's owner ("Grace Austin's residency"), if any. */
const ownerNamed = (hint: string) => /^(?:the )?([A-Z][\w-]*(?: [A-Z][\w-]*)*)'s\b/.exec(hint.trim())?.[1];

/** One version of a program read (development.readProgram): its plan as the model drafts from it. */
function versionPlan(detail: Output, which: "published" | "draft") {
	const facts = detail.facts ?? {};
	const number = facts[`${which}Version`];
	if (typeof number !== "number") return null;
	const rows = (detail.rows ?? []).filter((r) => r.fields.version === number);
	return {
		number,
		rhythm: facts[`${which}Rhythm`] as Rhythm,
		expectedMonths: Number(facts[`${which}Months`]),
		stages: rows
			.filter((r) => r.fields.part === "stage")
			.map((r) => ({ label: r.label, minMonths: Number(r.fields.minMonths), maxMonths: Number(r.fields.maxMonths) })),
		milestones: rows
			.filter((r) => r.fields.part === "milestone")
			.map((r) => ({
				lineage: r.fields.lineage as string | undefined,
				title: r.label,
				description: (r.fields.description ?? null) as string | null,
				handsOn: r.fields.handsOn === true,
			})),
		readings: rows.filter((r) => r.fields.part === "reading").map((r) => r.label),
	};
}
type Plan = NonNullable<ReturnType<typeof versionPlan>>;

/** The plan with the changes the request asks for, or null when it asks for none Evry understands. */
function edited(base: Plan, ask: string): Plan | null {
	const plan: Plan = { ...base, milestones: [...base.milestones] };
	let changed = false;
	const rhythm = /\bmeet(?:s|ing)? (weekly|every week|every two weeks|every other week|monthly|every month)\b/i.exec(
		ask,
	)?.[1];
	if (rhythm) {
		const r = rhythm.toLowerCase();
		plan.rhythm = /two|other/.test(r) ? "every_two_weeks" : /month/.test(r) ? "monthly" : "weekly";
		changed = true;
	}
	for (const m of ask.matchAll(new RegExp(`\\brename (?:the )?milestone ${QUOTED} to ${QUOTED}`, "gi"))) {
		plan.milestones = plan.milestones.map((x) => (x.title === m[1] ? { ...x, title: m[2]! } : x));
		changed = true;
	}
	for (const m of ask.matchAll(new RegExp(`\\badd (?:a )?milestone ${QUOTED}`, "gi"))) {
		plan.milestones = [...plan.milestones, { lineage: undefined, title: m[1]!, description: null, handsOn: false }];
		changed = true;
	}
	return changed ? plan : null;
}

const planText = (plan: Plan, name?: string) =>
	`${name ? `${name}: m` : "M"}eets ${RHYTHM_TEXT[plan.rhythm]} over ${plan.expectedMonths} months. Stages: ${plan.stages
		.map((s) => `${s.label} (months ${s.minMonths}–${s.maxMonths})`)
		.join(", ")}. Milestones:\n${plan.milestones.map((m, i) => `${i + 1}. ${m.title}`).join("\n")}\nReading list: ${
		plan.readings.join("; ") || "none"
	}.`;

/** The pipeline answer for the user's seat: names by stage, or counts per stage only. */
function boardText(out: Output) {
	const facts = out.facts ?? {};
	const rows = out.rows ?? [];
	const stages = rows.filter((r) => r.kind === "stage");
	const people = rows.filter((r) => r.kind === "person");
	const org = String(facts.organization ?? "Your organization");
	if (facts.audience === "counts")
		return `${org}'s pipeline as of ${dayText(String(facts.asOf))}, as your Pipeline page shows it: counts per stage only. ${stages
			.map((s) => `${s.label}: ${String(s.fields.count)}`)
			.join(", ")}.`;
	const byStage = stages.map((s) => {
		const names = people.filter((p) => p.fields.stageId === s.id).map((p) => p.label);
		return `${s.label}: ${names.length ? names.join(", ") : "no one"}`;
	});
	return `${org}'s pipeline as of ${dayText(String(facts.asOf))}: ${byStage.join("; ")}.`;
}

function staleText(out: Output) {
	const facts = out.facts ?? {};
	const org = String(facts.organization ?? "your organization");
	if (facts.audience === "counts")
		return `Your Pipeline page shows counts per stage only, so I can't list who hasn't moved. ${boardText(out)}`;
	const people = (out.rows ?? []).filter((r) => r.kind === "person");
	const list = people.map(
		(p) =>
			`${p.label} (${String(p.fields.stage)}, last moved ${p.fields.lastMovedOn ? dayText(String(p.fields.lastMovedOn)) : "never"})`,
	);
	const head = people.length
		? `As of ${dayText(String(facts.asOf))}, ${people.length === 1 ? "1 person" : `${people.length} people`} in ${org}'s pipeline ${people.length === 1 ? "hasn't" : "haven't"} moved in six months: ${list.join(", ")}.`
		: `As of ${dayText(String(facts.asOf))}, everyone in ${org}'s pipeline you can see has moved in the last six months.`;
	return `${head} How it was measured: ${String(facts.measured)}`;
}

/** A plan of `months` months: three stages over the length and five starter milestones. */
function draft(months: number, kind: "apprenticeship" | "residency") {
	const q = Math.max(1, Math.round(months / 4));
	const t = Math.max(q, Math.round((3 * months) / 4));
	return {
		kind,
		name: `${months}-month ${kind}`,
		expectedMonths: months,
		rhythm: "every_two_weeks" as const,
		stages: [
			{ label: "Foundations", minMonths: 0, maxMonths: q },
			{ label: "Practice", minMonths: q, maxMonths: t },
			{ label: "Sending", minMonths: t, maxMonths: months },
		],
		milestones: [
			{ title: "Read the foundations articles with the director" },
			{ title: "Lead a small group for one season" },
			{ title: "Teach in a Sunday gathering" },
			{ title: "Shadow a church planter for a month" },
			{ title: "Write a personal ministry plan" },
		],
	};
}
const draftText = (plan: ReturnType<typeof draft>) =>
	`Here is a draft ${plan.name} plan. It meets every two weeks over ${plan.expectedMonths} months in three stages: ${plan.stages
		.map((s) => `${s.label} (months ${s.minMonths}–${s.maxMonths})`)
		.join(", ")}. Milestones:\n${plan.milestones.map((m, i) => `${i + 1}. ${m.title}`).join("\n")}`;

/** One step of a pipeline or program request, or null when it is none. */
export function pipelineStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	if (!offers("pipeline.listPeople")) return null;
	const system = systemText(options.prompt);
	const rule = (reply: string) => (system.includes(reply) ? say(reply) : null);
	const roleRule = () => {
		const r = /Only an Owner or Admin can [^.]+\./.exec(system)?.[0];
		return r ? say(r) : null;
	};
	const quoted = (reply: string) => (system.includes(reply) ? `${reply} ` : "");
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const board = outputs.findLast((o) => o.operation === "pipeline.listPeople");
	const plan = outputs.findLast((o) => o.operation === "development.draftPlan");
	const readBoard = (input: Record<string, unknown> = {}) =>
		call("pipeline_read", { operation: "pipeline.listPeople", input });

	const drafted = DRAFT.exec(text);
	const move = MOVE.exec(text);
	const next = NEXT.exec(text);
	const shown = SHOW_PROGRAM.exec(text);
	if (!(
		next ||
		PUBLISH.test(text) ||
		shown ||
		LOG.test(text) ||
		JUDGE.test(text) ||
		drafted ||
		move ||
		STALE.test(text) ||
		PIPELINE.test(text) ||
		NAMED.test(text)
	))
		return null;
	if (last?.error) return say(`I couldn't do that (${String(last.error)}).`);

	// A program's next version: read the programs, then the one named, then propose the changed plan for its director.
	const programs = outputs.findLast((o) => o.operation === "development.readProgram" && !o.facts?.programId);
	const detail = outputs.findLast((o) => o.operation === "development.readProgram" && o.facts?.programId);
	const hint = next?.[1] ?? shown?.[1];
	if (hint) {
		if (typeof last?.proposalId === "string") {
			const [card] = (last.rows ?? []) as Row[];
			const plan = detail && edited((versionPlan(detail, "draft") ?? versionPlan(detail, "published"))!, text);
			return say(
				`Here is the plan for ${card?.label ?? "the next version"} of ${String(detail?.facts?.program)}. ${plan ? planText(plan) : ""}\n\nI prepared a review card that lists each change and what stays the same. Nothing is saved until you approve it, nothing is published, and only you publish it from Programs.`,
			);
		}
		if (!programs) return call("pipeline_read", { operation: "development.readProgram", input: {} });
		const owner = ownerNamed(hint);
		if (owner && owner !== String(programs.facts?.organization)) return rule(PIPELINE_RULES.ownPrograms);
		const program = programNamed(programs.rows ?? [], owner ? hint.slice(hint.indexOf("'s") + 2) : hint);
		if (!program)
			return say(
				`${String(programs.facts?.organization ?? "Your organization")} has no program like that. Its programs: ${
					(programs.rows ?? []).map((r) => r.label).join(", ") || "none yet"
				}.`,
			);
		if (!detail)
			return call("pipeline_read", { operation: "development.readProgram", input: { programId: program.id } });
		const facts = detail.facts ?? {};
		const published = versionPlan(detail, "published");
		const draft = versionPlan(detail, "draft");
		if (!next)
			return say(
				[
					`${String(facts.program)}, directed by ${String(facts.director)}.`,
					published ? `Version ${published.number}, published: ${planText(published)}` : "No version is published yet.",
					draft ? `Draft of Version ${draft.number} in progress: ${planText(draft)}` : null,
				]
					.filter(Boolean)
					.join("\n\n"),
			);
		if (facts.directedByYou !== true || !offers("development.draftNextVersion"))
			return say(
				`${quoted(PIPELINE_RULES.directorOnly)}${String(facts.program)} is directed by ${String(facts.director)}, so only ${String(facts.director)} edits its plan and I can't draft its next version for you. Nothing changed.`,
			);
		const base = (draft ?? published)!;
		const plan = edited(base, next[2] ?? "");
		if (!plan)
			return say(
				`What should change in the next version of ${String(facts.program)}? ${planText(base, draft ? `Draft of Version ${base.number}` : `Version ${base.number}`)}`,
			);
		return call("propose_change", {
			operation: "development.draftNextVersion",
			input: {
				programId: facts.programId,
				plan: {
					rhythm: plan.rhythm,
					expectedMonths: plan.expectedMonths,
					stages: plan.stages,
					milestones: plan.milestones.map((m) =>
						m.lineage
							? { lineage: m.lineage, title: m.title, description: m.description, handsOn: m.handsOn }
							: { title: m.title },
					),
				},
			},
		});
	}
	// Publishing, enrolling and applying versions are done on the program's page in Programs.
	if (PUBLISH.test(text)) return rule(PIPELINE_RULES.programNative);

	// Never in Evry: conversations, notes and milestones are logged in the app; notes and rankings are never read.
	if (LOG.test(text)) return rule(PIPELINE_RULES.nativeOnly);
	if (JUDGE.test(text)) return rule(PIPELINE_RULES.noJudgment);

	if (drafted) {
		const months = Number(drafted[1]);
		const kind = drafted[2]!.toLowerCase() as "apprenticeship" | "residency";
		const p = draft(Math.min(Math.max(months, 1), 120), kind);
		if (typeof last?.proposalId === "string")
			return say(
				`${draftText(p)}\n\nI prepared a review card that lists exactly what would be created. Nothing is created, published or enrolled until you approve it.`,
			);
		if (!plan) return call("pipeline_read", { operation: "development.draftPlan", input: {} });
		if (!offers("development.saveProgram") || plan.facts?.canCreate !== true)
			return say(
				`${draftText(p)}\n\nOnly an Owner or Admin of ${String(plan.facts?.organization ?? "your organization")} can create a program, so I can't prepare one for you to approve. Nothing was created.`,
			);
		const name = drafted[3];
		const director = (plan.rows ?? []).find((r) => name && r.label.toLowerCase().startsWith(name.toLowerCase()));
		if (!director) return say(`${draftText(p)}\n\nWho should direct it? Name one of your staff.`);
		return call("propose_change", {
			operation: "development.saveProgram",
			input: { ...p, directorSeatId: director.id },
		});
	}

	if (move) {
		if (typeof last?.proposalId === "string") {
			const [person] = (last.rows ?? []) as Row[];
			const changes = (person?.fields.changes ?? []) as { after: unknown }[];
			return say(
				`I prepared a review card to move ${person?.label ?? "them"} to ${String(changes[0]?.after ?? "that stage")}. Type the reason for the move on the card yourself: I don't keep the reason you gave me. Nothing moves until you approve.`,
			);
		}
		if (!offers("pipeline.proposeStageMove")) return roleRule();
		if (!board) return readBoard();
		const who = move[1]!.toLowerCase();
		const person = (board.rows ?? []).find((r) => r.kind === "person" && r.label.toLowerCase().startsWith(who));
		const stage = (board.rows ?? []).find(
			(r) => r.kind === "stage" && r.label.toLowerCase() === move[2]!.trim().toLowerCase(),
		);
		if (!person) return say(`I can't find ${move[1]} in your pipeline.`);
		if (!stage) return say(`Your pipeline has no stage called ${move[2]!.trim()}.`);
		return call("propose_change", {
			operation: "pipeline.proposeStageMove",
			input: { personId: person.id, stageId: stage.id },
		});
	}

	// Another organization's pipeline, or a person who may be in one: only this organization's own pipeline is read.
	const other = OTHER_PIPELINE.exec(text)?.[1];
	if (other && !/^(?:our|my)$/i.test(other)) {
		if (!board) return readBoard();
		return say(
			String(board.facts?.organization) === other
				? boardText(board)
				: `${quoted(PIPELINE_RULES.ownPipeline)}${boardText(board)}`,
		);
	}
	if (STALE.test(text)) {
		if (!board) return readBoard({ stale: true });
		return say(staleText(board));
	}
	const named = NAMED.exec(text)?.[1];
	if (named && !/^(?:Evry|Who|What)$/.test(named)) {
		if (!board) return readBoard();
		const person = (board.rows ?? []).find(
			(r) => r.kind === "person" && r.label.toLowerCase().startsWith(named.toLowerCase()),
		);
		if (person)
			return say(
				`${person.label} is in ${String(person.fields.stage)}, last moved ${person.fields.lastMovedOn ? dayText(String(person.fields.lastMovedOn)) : "never"}.`,
			);
		return say(
			`No one named ${named} is in ${String(board.facts?.organization ?? "your organization")}'s pipeline that you can see.`,
		);
	}
	if (PIPELINE.test(text)) {
		if (!board) return readBoard();
		return say(boardText(board));
	}
	return null;
}
