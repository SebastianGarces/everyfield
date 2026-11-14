// The assessment evaluation (WP-042, PI-036) on the synthetic test church, with the scripted model and the scripted
// graded judge only: no paid call. Every case runs intelligence.evaluateAssessment and is listed one by one with each draft's
// text, the exact rules it broke, its language grade, and pass or fail against what the case expects. Nothing is
// averaged. The report is written outside the repository:
//
//   ASSESSMENT_EVAL_REPORT=/tmp/assessment-eval.md node --conditions=react-server --import tsx --test \
//     tests/integration/intelligence/assessment-eval.test.mts
//
// (default path: <os tmpdir>/everyfield-assessment-eval.md). The test fails, naming each failing case, when any case
// does not behave as expected.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftOutput, languagePasses } from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { createAssessments, draftText } from "../../../packages/domain/src/intelligence/index.ts";
import {
	scriptedAssessmentDrafter,
	scriptedLanguageJudge,
} from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { church, type Church } from "./assessment-church.mts";

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
	outcome: string;
	reason: string | null;
	drafts: any[];
	passed: boolean;
	problems: string[];
}[] = [];

before(async () => {
	c = await church("t298e");
	await c.release("methodology-2026.10");
	plants.harvest = await c.harvest();
	plants.unknown = await c.unknownCount();
	plants.phase3 = await c.phaseThree();
});
after(async () => {
	const path = process.env.ASSESSMENT_EVAL_REPORT || join(tmpdir(), "everyfield-assessment-eval.md");
	writeFileSync(path, report());
	console.log(`assessment evaluation report: ${path}`);
	await c?.database.close();
});

for (const k of CASES)
	test(`AC:PI-CASE-027 assessment evaluation: ${k.id}`, async () => {
		const p = plants[k.plant];
		const runId = randomUUID();
		const drafter = scriptedAssessmentDrafter({
			script: (draft, call) =>
				k.change && (k.change.on ?? [1, 2, 3]).includes(call.ordinal) ? k.change.edit(draft) : draft,
		});
		const result = ok(await assessments.evaluateAssessment(c.db, p.actor, { runId }, drafter));
		const stored = await c.one(sql`SELECT drafts, model_input FROM assessment_run WHERE id=${runId}`);
		const drafts = (stored.drafts as any[]).map((d) => {
			const parsed = draftOutput.safeParse(d.output);
			return {
				...d,
				text: parsed.success ? draftText(parsed.data) : JSON.stringify(d.output),
				language: parsed.success ? scriptedLanguageJudge(parsed.data) : null,
			};
		});
		const problems: string[] = [];
		if (result.outcome !== k.expect.outcome) problems.push(`outcome ${result.outcome}, expected ${k.expect.outcome}`);
		const first = [...new Set(drafts[0]?.violations.map((v) => v.rule) ?? [])].sort();
		if (JSON.stringify(first) !== JSON.stringify([...k.expect.firstDraft].sort()))
			problems.push(`draft 1 broke [${first.join(", ")}], expected [${k.expect.firstDraft.join(", ")}]`);
		const final = drafts.at(-1);
		const language = final?.language ? (languagePasses(final.language) ? "pass" : "fail") : "pass";
		if (language !== k.expect.language) problems.push(`language ${language}, expected ${k.expect.language}`);
		if (result.outcome === "failed" && result.drafts.length !== 3) problems.push("a failed run must hold three drafts");
		if (k.plant === "phase3" && !stored.model_input.passages.every((x) => x.phase === 3 || x.phase === null))
			problems.push("a Phase 3 run offered a passage of another phase");
		if (k.plant === "unknown" && result.outcome === "published") {
			const text = final.text;
			if (!/committed-adult count is unknown/.test(text) || !/classification/.test(text))
				problems.push("the Unknown count is not said to be unknown with what would settle it");
			if (/\b(at|below|above) 30\b/.test(text)) problems.push("the published draft compares the Unknown count with 30");
		}
		rows.push({ case: k, outcome: result.outcome, reason: result.reason, drafts, passed: !problems.length, problems });
		assert.deepEqual(problems, [], `${k.id}: ${problems.join("; ")}`);
	});

function report() {
	const lines = [
		"# Plant Intelligence assessment evaluation",
		"",
		"Scripted model (`assessment-scripted`) and scripted graded judge only; no paid call. One row per case, nothing averaged.",
		"",
		"| Case | Expected | Outcome | Draft 1 broke | Language (last draft) | Result |",
		"|---|---|---|---|---|---|",
		...rows.map((r) => {
			const first = r.drafts[0]?.violations.map((v) => v.rule).join(", ") || "nothing";
			const g = r.drafts.at(-1)?.language;
			const lang = g
				? `${languagePasses(g) ? "pass" : "FAIL"} (plain ${g.plain}, warm ${g.warm}, useful ${g.useful})`
				: "n/a";
			return `| ${r.case.id} | ${r.case.expect.outcome} | ${r.outcome}${r.reason ? ` (${r.reason})` : ""} | ${first} | ${lang} | ${r.passed ? "PASS" : "FAIL: " + r.problems.join("; ")} |`;
		}),
		"",
	];
	for (const r of rows) {
		lines.push(
			`## ${r.case.id}: ${r.passed ? "PASS" : "FAIL"}`,
			"",
			r.case.title,
			"",
			`Outcome: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`,
			"",
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
				const g = d.language;
				lines.push(
					`Language: ${languagePasses(g) ? "pass" : "FAIL"} (plain ${g.plain}/5, warm ${g.warm}/5, useful ${g.useful}/5)`,
					...g.failures.map((f) => `- \`${f.rule}\`: "${f.quote}"`),
					"",
				);
			}
		}
	}
	return lines.join("\n");
}
