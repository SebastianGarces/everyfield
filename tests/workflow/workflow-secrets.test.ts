import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { secretUses } from "./secret-uses.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("ci.yml and the local actions use no secret", () => {
	const actions = globSync(".github/actions/**/*.{yml,yaml}", { cwd: root }).sort();
	assert.ok(actions.includes(".github/actions/setup/action.yml"), "the scan reaches the setup action");
	for (const file of [".github/workflows/ci.yml", ...actions])
		assert.deepEqual(secretUses(readFileSync(join(root, file), "utf8")), [], file);
});

test("the detector finds every form of the secrets context", () => {
	const cases: [string, string[]][] = [
		["env:\n  T: ${{ secrets.TOKEN }}", ["secrets.TOKEN"]],
		["env:\n  T: ${{ secrets['TOKEN'] }}", ["secrets['TOKEN']"]],
		["env:\n  T: ${{ secrets [ 'TOKEN' ] }}", ["secrets [ 'TOKEN' ]"]],
		["env:\n  T: '${{ secrets[''TOKEN''] }}'", ["secrets[''TOKEN'']"]],
		["env:\n  T: ${{ SECRETS.token || Secrets['b'] }}", ["SECRETS.token", "Secrets['b']"]],
		["env:\n  T: ${{ toJSON(secrets) }}", ["secrets"]],
		["env:\n  T: ${{ toJSON( SECRETS ) }}", ["SECRETS"]],
		["env:\n  T: ${{ format('{0} }}', secrets.TOKEN) }}", ["secrets.TOKEN"]],
		["run: |\n  echo ${{ join(secrets.*, ',') }}", ["secrets.*"]],
		["env:\n  T: >-\n    ${{\n      secrets.TOKEN\n    }}", ["secrets.TOKEN"]],
		["    if: secrets.TOKEN != ''", ["secrets.TOKEN"]],
		["      - if: 'secrets.TOKEN != '''''", ["secrets.TOKEN"]],
		["    if: >-\n      always() &&\n      secrets.TOKEN\n    runs-on: x", ["secrets.TOKEN"]],
		["    if: ${{ secrets.TOKEN }}", ["secrets.TOKEN"]],
		["    uses: ./x.yml\n    secrets: inherit", ["secrets: inherit"]],
		["    Secrets: 'INHERIT'", ["secrets: inherit"]],
		['  call: { uses: ./x.yml, "secrets": inherit }', ["secrets: inherit"]],
		["    secrets:\n      inherit", ["secrets: inherit"]],
	];
	for (const [text, expected] of cases) assert.deepEqual(secretUses(text), expected, text);
});

test("the detector passes prose and other names", () => {
	for (const text of [
		"      - name: Nightly checks, no secrets. Nothing here reads secrets",
		"    outputs:\n      secrets-x: ${{ steps.secrets-x.outputs.value }}",
		"env:\n  A: ${{ needs.build.outputs.secrets-x }}\n  B: ${{ needs.secrets.outputs.x }}\n  C: ${{ env.no_secrets }}",
		"if: needs.secrets.outputs.x == 'no secrets'\nname: no secrets.",
		"env:\n  A: ${{ hashFiles('secrets/**') }}",
		"    if: always()\n    name: no secrets",
		"run: cat secrets.txt",
	])
		assert.deepEqual(secretUses(text), [], text);
});
