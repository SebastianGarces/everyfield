import { execFileSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emailProblems, emailScoped } from "./test-emails.mjs";

const root = process.env.EVERYFIELD_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(join(root, file), "utf8");
const repoFiles = () =>
	execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

const failures = [];

for (const file of repoFiles().filter((f) => f === ".npmrc" || f.endsWith("/.npmrc"))) {
	const text = read(file);
	if (/tiptap/i.test(text)) failures.push(`${file}: names Tiptap; the editor uses only the free MIT packages`);
	if (/_authToken/i.test(text)) failures.push(`${file}: holds a registry token`);
}

for (const file of repoFiles().filter((f) => emailScoped(f) && existsSync(join(root, f)))) {
	const text = read(file);
	if (!text.includes("\0")) failures.push(...emailProblems(file, text));
}

const templateClass = read("evf.toml")
	.split("[[policy.class]]")
	.find((block) => /^name = "document-templates"$/m.test(block));
const ownedBlock = /^paths = \[(.*?)\]/ms.exec((templateClass ?? "").replace(/^\s*#.*$/gm, ""))?.[1] ?? "";
const owned = [...ownedBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!templateClass || !/^outcome = "owner"$/m.test(templateClass))
	failures.push('evf.toml: has no document-templates class with outcome = "owner"');
const documents = "packages/domain/src/documents";
const templates = `${documents}/templates`;
for (const file of [
	...readdirSync(join(root, templates))
		.filter((name) => name.endsWith(".json"))
		.map((name) => `${templates}/${name}`),
	...readdirSync(join(root, documents), { recursive: true })
		.filter((name) => name.endsWith("-content.ts"))
		.map((name) => `${documents}/${name}`),
]) {
	if (!owned.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)))
		failures.push(`${file}: is not in the document-templates owner class of evf.toml; add its exact path there`);
}

const scripted = globSync(
	[".github/workflows/*", "package.json", "apps/*/package.json", "packages/*/package.json", "tools/*/package.json"],
	{ cwd: root },
);
for (const file of scripted) {
	const text = read(file);
	const checked = file.endsWith("package.json") ? JSON.stringify(JSON.parse(text).scripts ?? {}) : text;
	if (/VERCEL_ENV/.test(checked))
		failures.push(`${file}: sets VERCEL_ENV; only a Vercel deployment may, since it opens the mail guard`);
}

if (failures.length) {
	console.error(`Repo file checks failed (scripts/lint/check-repo-files.mjs):\n${failures.join("\n")}`);
	process.exit(1);
}
