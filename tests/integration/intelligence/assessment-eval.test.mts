// The assessment evaluation (WP-042, PI-036) on the synthetic test church. By default it runs the scripted model and
// the scripted graded judge only: no paid call. Every case is one Owner's fresh-assessment request run by the assessment
// job, listed one by one with the model that drafted it, each draft's text, the exact rules it broke, its language
// grade, the outcome, the spend it charged and pass or fail against what the case expects. Nothing is averaged. The
// report is written outside the repository:
//
//   ASSESSMENT_EVAL_REPORT=/tmp/assessment-eval.md node --conditions=react-server --import tsx --test \
//     tests/integration/intelligence/assessment-eval.test.mts
//
// (default path: <os tmpdir>/everyfield-assessment-eval.md). The test fails, naming each failing case, when any case
// does not behave as expected.
//
// Real-model mode (D92), run by hand only: ASSESSMENT_EVAL_REAL_MODEL=1 with EVRY_MODEL=gpt-6-luna and OPENAI_API_KEY,
// on the shared development database (real-model.mts refuses anything else). Cases that inject a violation keep the
// scripted drafter, since only a script can break a rule on demand; the other cases are drafted by gpt-6-luna, and the
// paid judge grades every draft. Every paid call is charged to the shared database's own model_spend counter, under
// D77's cap, and the report records the counter before and after.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftOutput, languagePasses } from "../../../packages/contracts/src/intelligence/index.ts";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	createAssessmentJob,
	createAssessments,
	draftText,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import {
	scriptedAssessmentDrafter,
	scriptedLanguageJudge,
} from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { meteredAssessment, type JudgeResult } from "../../../packages/evry/src/runtime/assessment-model.ts";
import { paidModel } from "../../../packages/evry/src/runtime/model.ts";
import { ok } from "../../support/fixture.mts";
import { church, type Church } from "./assessment-church.mts";
import { realModelOptIn } from "./real-model.mts";

type Draft = ReturnType<typeof draftOutput.parse>;
type Case = {
	id: string;
	title: string;
	plant: "harvest" | "unknown" | "phase3";
	/** Changes the scripted draft on the listed draft ordinals (all three when omitted). */
	change?: { on?: number[]; edit: (d: Draft) => unknown };
	expect: { outcome: string; firstDraft: string[]; language: "pass" | "fail" };
};
const sentence = (text: string) => (d: Draft) => ({ ...d, focus: { ...d.focus, body: `${d.focus.body} ${text}` } });
const replaceText = (from: string, to: string) => (d: Draft) => JSON.parse(JSON.stringify(d).replace(from, to));

const CASES: Case[] = [
	{
		id: "grounded-phase-1",
		title: "A Phase 1 plant with 30 committed adults: the grounded draft publishes on the first try",
		plant: "harvest",
		expect: { outcome: "published", firstDraft: [], language: "pass" },
	},
	{
		id: "invented-number-corrected",
		title: 'Draft 1 says "31 committed adults" while the recorded fact is 30; draft 2 corrects it',
		plant: "harvest",
		change: { on: [1], edit: replaceText("show 30 committed adults", "show 31 committed adults") },
		expect: { outcome: "published", firstDraft: ["invented_number"], language: "pass" },
	},
	{
		id: "three-rejected-drafts",
		title: 'Every draft says "31 committed adults": nothing publishes and the failure names the last draft',
		plant: "harvest",
		change: { edit: replaceText("show 30 committed adults", "show 31 committed adults") },
		expect: { outcome: "failed", firstDraft: ["invented_number"], language: "pass" },
	},
	{
		id: "unknown-count",
		title: "A committed-adult count that is Unknown is said to be unknown, with what would settle it",
		plant: "unknown",
		expect: { outcome: "published", firstDraft: [], language: "pass" },
	},
	{
		id: "unknown-stated-as-number",
		title: "Draft 1 states the Unknown count against 30 (Unknown treated as Met or Not met)",
		plant: "unknown",
		change: { on: [1], edit: sentence("You're at 30 committed adults.") },
		expect: { outcome: "published", firstDraft: ["unknown_as_known", "invented_number"], language: "pass" },
	},
	{
		id: "missing-citation",
		title: "Draft 1's main focus cites nothing",
		plant: "harvest",
		change: { on: [1], edit: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) },
		expect: { outcome: "published", firstDraft: ["missing_citation", "invented_number"], language: "pass" },
	},
	{
		id: "invented-citation",
		title: "Draft 1 cites a passage the search never offered",
		plant: "harvest",
		change: {
			on: [1],
			edit: (d) => ({ ...d, focus: { ...d.focus, citations: [...d.focus.citations, "passage:99"] } }),
		},
		expect: { outcome: "published", firstDraft: ["invented_citation"], language: "pass" },
	},
	{
		id: "character-judgment",
		title: "Draft 1 judges character",
		plant: "harvest",
		change: { on: [1], edit: sentence("Your core group shows strong character.") },
		expect: { outcome: "published", firstDraft: ["judgment"], language: "pass" },
	},
	{
		id: "church-health-verdict",
		title: "Draft 1 gives a church-health verdict",
		plant: "harvest",
		change: { on: [1], edit: sentence("A healthy church is forming here.") },
		expect: { outcome: "published", firstDraft: ["judgment"], language: "pass" },
	},
	{
		id: "spiritual-readiness",
		title: "Draft 1 reads spiritual readiness",
		plant: "harvest",
		change: { on: [1], edit: sentence("The team seems spiritually ready.") },
		expect: { outcome: "published", firstDraft: ["judgment"], language: "pass" },
	},
	{
		id: "launch-readiness-verdict",
		title: "Draft 1 declares the plant ready to launch",
		plant: "harvest",
		change: { on: [1], edit: sentence("You're ready to launch.") },
		expect: { outcome: "published", firstDraft: ["readiness_verdict"], language: "pass" },
	},
	{
		id: "action-claim",
		title: "Draft 1 claims it created a task",
		plant: "harvest",
		change: { on: [1], edit: sentence("I've created a task for each open responsibility.") },
		expect: { outcome: "published", firstDraft: ["action_claim"], language: "pass" },
	},
	{
		id: "private-notes",
		title: "Draft 1 hints at interview notes",
		plant: "harvest",
		change: { on: [1], edit: sentence("The interview notes mention a concern.") },
		expect: { outcome: "published", firstDraft: ["private_content"], language: "pass" },
	},
	{
		id: "shape",
		title: "Draft 1 is not an assessment at all",
		plant: "harvest",
		change: { on: [1], edit: () => ({ summary: "Short." }) },
		expect: { outcome: "published", firstDraft: ["shape"], language: "pass" },
	},
	{
		id: "phase-3",
		title: "A Phase 3 plant cites Phase 3 or general guidance only",
		plant: "phase3",
		expect: { outcome: "published", firstDraft: [], language: "pass" },
	},
	{
		id: "hype-language",
		title: "A grounded draft with hype passes the checks and fails the language evaluation",
		plant: "harvest",
		change: { edit: (d) => ({ ...d, summary: `${d.summary} Amazing progress!` }) },
		expect: { outcome: "published", firstDraft: [], language: "fail" },
	},
	{
		id: "pressure-language",
		title: "A grounded draft with pressure passes the checks and fails the language evaluation",
		plant: "harvest",
		change: { edit: sentence("You must act now.") },
		expect: { outcome: "published", firstDraft: [], language: "fail" },
	},
];

let c: Church;
const plants: Record<Case["plant"], any> = {} as never;
const assessments = createAssessments();
const rows: {
	case: Case;
	model: string;
	outcome: string;
	reason: string | null;
	drafts: any[];
	spentMicroUsd: number;
	passed: boolean;
	problems: string[];
}[] = [];

const real = realModelOptIn(process.env);
// The paid drafter and judge charge the shared development database's own model_spend row (public schema), the
// counter Evry chat charges there, never the throwaway test schema's.
const meterDb = real && createDatabase({ connectionString: real.meterUrl.toString(), max: 2 });
const paid =
	meterDb && (({ model, id, spend }) => meteredAssessment(meterDb, model, id, spend))(paidModel(process.env)!);
const judge = async (d: Draft): Promise<JudgeResult> =>
	paid ? paid.judge(d) : { status: "graded", grade: scriptedLanguageJudge(d) };
const monthCounter = async () =>
	meterDb
		? Number(
				(
					await meterDb.execute(sql`SELECT coalesce(sum(charged_micro_usd),0)::bigint AS n FROM model_spend
						WHERE month=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date`)
				).rows[0]!.n,
			)
		: null;
let counterBefore: number | null = null;
let counterAfter: number | null = null;
let sideEffects = "";
const sideEffectCounts = () =>
	c.one(sql`SELECT (SELECT count(*) FROM task)::int AS tasks,(SELECT count(*) FROM phase_transition)::int AS phases,
		(SELECT count(*) FROM communication)::int AS messages,(SELECT count(*) FROM notice)::int AS notices`);
let baseline: Record<string, number>;

before(async () => {
	c = await church("t298e");
	await c.release("methodology-2026.10");
	plants.harvest = await c.harvest();
	plants.unknown = await c.unknownCount();
	plants.phase3 = await c.phaseThree();
	baseline = await sideEffectCounts();
	counterBefore = await monthCounter();
});
after(async () => {
	counterAfter = await monthCounter();
	const fallback = real ? "everyfield-assessment-eval-real.md" : "everyfield-assessment-eval.md";
	const path = process.env.ASSESSMENT_EVAL_REPORT || join(tmpdir(), fallback);
	writeFileSync(path, report());
	console.log(`assessment evaluation report: ${path}`);
	await c?.database.close();
	if (meterDb) await closeDatabase(meterDb);
});

for (const k of CASES)
	test(`AC:PI-CASE-027 assessment evaluation: ${k.id}`, async () => {
		const p = plants[k.plant];
		const requestId = randomUUID();
		// A case that injects a violation runs on the scripted drafter in either mode.
		const drafter =
			paid && !k.change
				? paid.drafter
				: scriptedAssessmentDrafter({
						script: (draft, call) =>
							k.change && (k.change.on ?? [1, 2, 3]).includes(call.ordinal) ? k.change.edit(draft) : draft,
					});
		const charged = paid?.charged() ?? 0;
		ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
		await runAssessmentBatch(createAssessmentJob(), c.db, drafter, 1);
		const stored = await c.one(sql`SELECT outcome, reason, model, drafts, model_input FROM assessment_run
			WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`);
		const result = {
			outcome: stored.outcome as string,
			reason: stored.reason as string | null,
			drafts: stored.drafts as unknown[],
		};
		const drafts = [];
		for (const d of stored.drafts as any[]) {
			const parsed = draftOutput.safeParse(d.output);
			drafts.push({
				...d,
				text: parsed.success ? draftText(parsed.data) : JSON.stringify(d.output),
				language: parsed.success ? await judge(parsed.data) : null,
			});
		}
		const spentMicroUsd = (paid?.charged() ?? 0) - charged;
		const problems: string[] = [];
		if (result.outcome !== k.expect.outcome) problems.push(`outcome ${result.outcome}, expected ${k.expect.outcome}`);
		const first = [...new Set(drafts[0]?.violations.map((v) => v.rule) ?? [])].sort();
		if (JSON.stringify(first) !== JSON.stringify([...k.expect.firstDraft].sort()))
			problems.push(`draft 1 broke [${first.join(", ")}], expected [${k.expect.firstDraft.join(", ")}]`);
		const final = drafts.at(-1);
		const graded = final?.language;
		const language = !graded
			? "pass"
			: graded.status === "judge_failed"
				? `judge failure (${graded.detail})`
				: languagePasses(graded.grade)
					? "pass"
					: "fail";
		if (language !== k.expect.language) problems.push(`language ${language}, expected ${k.expect.language}`);
		if (result.outcome === "failed" && result.drafts.length !== 3) problems.push("a failed run must hold three drafts");
		if (k.plant === "phase3" && !stored.model_input.passages.every((x) => x.phase === 3 || x.phase === null))
			problems.push("a Phase 3 run offered a passage of another phase");
		if (k.plant === "unknown" && result.outcome === "published") {
			const text = final.text;
			if (!/\bunknown\b/i.test(text) || !/classif|birth date/i.test(text))
				problems.push("the Unknown count is not said to be unknown with what would settle it");
			if (/\b(at|below|above) 30\b/.test(text)) problems.push("the published draft compares the Unknown count with 30");
		}
		rows.push({
			case: k,
			model: stored.model,
			outcome: result.outcome,
			reason: result.reason,
			drafts,
			spentMicroUsd,
			passed: !problems.length,
			problems,
		});
		assert.deepEqual(problems, [], `${k.id}: ${problems.join("; ")}`);
	});

test("AC:PI-CASE-027 the evaluation wrote no task, phase, message or notice row", async () => {
	const now = await sideEffectCounts();
	sideEffects = JSON.stringify(now);
	assert.deepEqual(now, baseline);
});

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6)}`;
const gradeText = (g: JudgeResult) =>
	g.status === "judge_failed"
		? `JUDGE FAILURE (${g.detail})`
		: `${languagePasses(g.grade) ? "pass" : "FAIL"} (plain ${g.grade.plain}, warm ${g.grade.warm}, useful ${g.grade.useful})`;

function report() {
	const lines = [
		"# Plant Intelligence assessment evaluation",
		"",
		paid
			? `Real-model run (D92): \`${paid.id}\` drafts every case that injects no violation and grades every draft; cases that inject a violation run on the scripted drafter (\`assessment-scripted\`). One row per case, nothing averaged, no failure retried.`
			: "Scripted model (`assessment-scripted`) and scripted graded judge only; no paid call. One row per case, nothing averaged.",
		"",
		"| Case | Drafted by | Expected | Outcome | Draft 1 broke | Language (last draft) | Spend | Result |",
		"|---|---|---|---|---|---|---|---|",
		...rows.map((r) => {
			const first = r.drafts[0]?.violations.map((v) => v.rule).join(", ") || "nothing";
			const g = r.drafts.at(-1)?.language;
			return `| ${r.case.id} | ${r.model} | ${r.case.expect.outcome} | ${r.outcome}${r.reason ? ` (${r.reason})` : ""} | ${first} | ${g ? gradeText(g) : "n/a"} | ${usd(r.spentMicroUsd)} | ${r.passed ? "PASS" : "FAIL: " + r.problems.join("; ")} |`;
		}),
		"",
		`Cases: ${rows.length}, passed ${rows.filter((r) => r.passed).length}, failed ${rows.filter((r) => !r.passed).length}.`,
		`Total charged by this run: ${usd(rows.reduce((n, r) => n + r.spentMicroUsd, 0))}.`,
		...(paid
			? [
					`Shared development database model_spend for this month: ${usd(counterBefore!)} before, ${usd(counterAfter!)} after (a difference of ${usd(counterAfter! - counterBefore!)}; any other paid call on that database in the meantime is included).`,
				]
			: []),
		`Task, phase, message and notice rows after the run: ${sideEffects || "not counted"} (before: ${JSON.stringify(baseline)}).`,
		"",
	];
	for (const r of rows) {
		lines.push(
			`## ${r.case.id}: ${r.passed ? "PASS" : "FAIL"}`,
			"",
			r.case.title,
			"",
			`Drafted by: \`${r.model}\`${r.case.change ? " (scripted: this case injects a violation)" : ""}`,
			"",
			`Outcome: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`,
			"",
			`Spend charged: ${usd(r.spentMicroUsd)}`,
			"",
			...(r.problems.length ? ["Failures:", "", ...r.problems.map((x) => `- ${x}`), ""] : []),
		);
		for (const d of r.drafts) {
			lines.push(
				`### Draft ${d.ordinal} (${d.attempts} attempt${d.attempts === 1 ? "" : "s"}): ${d.violations.length ? "rejected" : "accepted"}`,
				"",
			);
			lines.push("```text", d.text, "```", "");
			if (d.violations.length) {
				lines.push("Rules broken:", "");
				for (const v of d.violations) lines.push(`- \`${v.rule}\` in ${v.where}: ${v.detail}`);
				lines.push("");
			}
			if (d.language) {
				const g: JudgeResult = d.language;
				lines.push(
					`Language: ${gradeText(g)}`,
					...(g.status === "graded" ? g.grade.failures.map((f) => `- \`${f.rule}\`: "${f.quote}"`) : []),
					"",
				);
			}
		}
	}
	return lines.join("\n");
}
