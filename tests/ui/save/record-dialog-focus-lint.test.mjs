// BUG-249 (F4b): RecordDialog alone sets the opening focus in its onOpenAutoFocus handler. A field with a bare autoFocus
// inside its content takes the focus first and breaks the refusal focus, the Tab trap and the Escape return; #247's
// meeting forms brought it back once. The web lint refuses it. This runs the real apps/web ESLint config on fixtures
// and on every source file that renders RecordDialog.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web");
const { ESLint } = createRequire(join(web, "package.json"))("eslint");
const eslint = new ESLint({ cwd: web });

const RULE = "no-restricted-syntax";
const fixture = (body) => `import { RecordDialog } from "../components/save/parts.tsx";
import { Field, Input } from "@everyfield/ui";

export function Form({ switched }: { switched: boolean }) {
	return (
		${body}
	);
}
`;

async function refusals(body) {
	const [result] = await eslint.lintText(fixture(body), { filePath: join(web, "src/features/fixture.tsx") });
	return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

test("BUG-249: a bare autoFocus inside RecordDialog content fails the web lint", async () => {
	const refused = {
		bare: `<RecordDialog title="T" action="Save" onClose={() => {}} onSubmit={() => true}>
			<Input autoFocus />
		</RecordDialog>`,
		literalTrue: `<RecordDialog title="T" action="Save" onClose={() => {}} onSubmit={() => true}>
			<Input autoFocus={true} />
		</RecordDialog>`,
		nestedComponentProp: `<RecordDialog title="T" action="Save" onClose={() => {}} onSubmit={() => true}>
			<Field label="Name">
				<div>
					<Input value="" onChange={() => {}} autoFocus />
				</div>
			</Field>
		</RecordDialog>`,
	};
	for (const [name, body] of Object.entries(refused)) {
		assert.equal((await refusals(body)).length, 1, `${name} must be refused`);
	}
});

test("BUG-249: state-driven autoFocus and autoFocus outside RecordDialog pass the web lint", async () => {
	const allowed = {
		switchedField: `<RecordDialog title="T" action="Save" onClose={() => {}} onSubmit={() => true}>
			<Input autoFocus={switched} />
		</RecordDialog>`,
		outsideRecordDialog: `<form>
			<Input autoFocus />
		</form>`,
	};
	for (const [name, body] of Object.entries(allowed)) {
		assert.deepEqual(await refusals(body), [], `${name} must pass`);
	}
});

test("BUG-249: no source file that renders RecordDialog sets a bare autoFocus in its content", async () => {
	const files = execFileSync("git", ["grep", "-l", "<RecordDialog", "--", "src"], { cwd: web, encoding: "utf8" })
		.trim()
		.split("\n");
	assert.ok(files.length >= 5, `found only ${files.length} RecordDialog files`);
	const results = await eslint.lintFiles(files);
	const found = results.flatMap((r) =>
		r.messages.filter((m) => m.ruleId === RULE).map((m) => `${r.filePath}:${m.line}`),
	);
	assert.deepEqual(found, []);
});
