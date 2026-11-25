import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SKILL = ".agents/skills/policy-writing/SKILL.md";
const { shared } = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));

const MISSPELLED = ["Every", "Field"].join("");
const ALLOWED_TIMEFRAMES = [];

const COUNT =
	"(?:\\d+|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-\\w+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred)";
const UNIT = "(?:minute|hour|day|week|month|year)s?";
const BREACHES = {
	vendor: [
		/\b(?:vercel|neon|tigris|amazon|postgres(?:ql)?|cloudflare|openai|anthropic|langfuse|google cloud|azure)\b/gi,
		/\bAWS\b/g,
		/\bResend\b(?!\s+(?:the|your|our|an?|it|this|that|any)\b)/g,
	],
	region: [
		/\b[a-z]{2}(?:-[a-z]+)?-(?:north|south|east|west|central)[a-z]*-?\d\b/gi,
		/\b(?:US|EU|AP|Asia Pacific|Europe|Canada) ?[-(]? ?(?:North|South|East|West|Central)(?:east|west)?\b/g,
		/\bN\. Virginia\b|\biad1\b/gi,
	],
	outage: [/\boutages?\b/gi],
	timeframe: [
		new RegExp(`(?<!\\b(?:once|twice|times) )\\b${COUNT}[\\s-]+(?:(?:business|calendar|working)\\s+)?${UNIT}\\b`, "gi"),
	],
	spelling: [/\bEvery[ -]Field\b/g, /\b(?!Everyfield\b|everyfield\.app\b)[Ee][Vv][Ee][Rr][Yy][Ff][Ii][Ee][Ll][Dd]\b/g],
	"bare plant": [/(?<!\bchurch\s)\bplants?\b/gi],
};

function breachesIn(line, allowed = ALLOWED_TIMEFRAMES) {
	return Object.entries(BREACHES).flatMap(([kind, patterns]) =>
		kind === "timeframe" && allowed.some((entry) => entry.line === line)
			? []
			: patterns.flatMap((pattern) => [...line.matchAll(pattern)].map(([text]) => ({ kind, text, line }))),
	);
}

function renderedLines(value) {
	if (typeof value === "string") return [value];
	return Object.entries(value).flatMap(([key, child]) => (key === "note" ? [] : renderedLines(child)));
}

function assertFollowsPolicyWriting(page) {
	const found = renderedLines(page).flatMap((line) => breachesIn(line));
	assert.equal(
		found.length,
		0,
		`Read ${SKILL} and reword:\n${found.map(({ kind, text, line }) => `  ${kind} "${text}" in: ${line}`).join("\n")}`,
	);
}

for (const name of ["privacy_page", "terms_page"]) {
	test(`${name} follows the policy-writing rules`, () => {
		assert.ok(renderedLines(shared[name]).length > 20);
		assertFollowsPolicyWriting(shared[name]);
	});

	test(`the ${name} check refuses each kind of breach and names the skill and the text`, () => {
		const planted = {
			Vercel: "Vercel hosts the site.",
			Neon: "Records are stored at Neon.",
			Tigris: "Files are in a Tigris bucket.",
			Resend: "Resend sends a copy.",
			Amazon: "The database runs on Amazon Web Services.",
			AWS: "The database runs on AWS.",
			Postgres: "Records are stored in a Postgres database.",
			"us-east-1": "It runs in us-east-1.",
			"US East": "It runs in the US East (N. Virginia) region.",
			outage: "One outage can affect both.",
			"7 days": "It leaves the backups within 7 days.",
			"12 months": "We keep it for 12 months.",
			"30-day": "There is a 30-day hold.",
			"thirty days": "We delete it after thirty days.",
			"a year": "We keep it for a year.",
			[MISSPELLED]: `${MISSPELLED} runs the site.`,
			"Every Field": "Every Field runs the site.",
			plants: "The number of plants you support.",
			plant: "Your plant owns it.",
		};
		for (const [text, line] of Object.entries(planted)) {
			const page = structuredClone(shared[name]);
			page.sections[0].paragraphs.push(line);
			assert.throws(
				() => assertFollowsPolicyWriting(page),
				({ message }) => message.includes(SKILL) && message.includes(`"${text}"`) && message.includes(line),
				line,
			);
		}
	});
}

test("ordinary words and notes pass", () => {
	const ordinary = [
		"You can resend the form.",
		"Resend your request if it fails.",
		"We ask for your church plant name and how many church plants you support.",
		"The planter form asks for your city in the United States.",
		"Email privacy@example.com about everyfield.app and Everyfield.",
		"Fill in every field.",
		"November 24, 2026",
	];
	for (const line of ordinary) assert.deepEqual(breachesIn(line), []);
	assertFollowsPolicyWriting({ note: "Vercel keeps it 7 days.", title: "Privacy policy" });
});

test("the allow list permits one line's timeframe and nothing else in it", () => {
	const line = "Neon deletes it within 30 days.";
	assert.deepEqual(
		breachesIn(line, [{ line, reason: "the law requires it" }]).map(({ kind }) => kind),
		["vendor"],
	);
	assert.equal(breachesIn(line, []).length, 2);
});
