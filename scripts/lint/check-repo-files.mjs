// Repo-file checks that no JS lint rule can see (D-619). `pnpm lint` runs this from the repository root.
// Each failure names the file. Run it alone with `node scripts/lint/check-repo-files.mjs`.
import { execFileSync } from "node:child_process";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(join(root, file), "utf8");
/** Files in git or about to be added: tracked plus untracked ones that .gitignore does not hide. */
const repoFiles = () =>
	execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

const failures = [];

// AC:DOC-EDIT-FREE: the editor uses only free Tiptap packages, so no .npmrc names Tiptap's private registry or a token.
for (const file of repoFiles().filter((f) => f === ".npmrc" || f.endsWith("/.npmrc"))) {
	const text = read(file);
	if (/tiptap/i.test(text)) failures.push(`${file}: names Tiptap; the editor uses only the free MIT packages`);
	if (/_authToken/i.test(text)) failures.push(`${file}: holds a registry token`);
}

// WP-036 criterion 13: a change to a built-in template waits for Sebastian, so each template file is in the
// document-templates owner class of evf.toml. evf matches exact paths or folder prefixes, never globs.
const templateClass = read("evf.toml")
	.split("[[policy.class]]")
	.find((block) => /^name = "document-templates"$/m.test(block));
const owned = [...(/^paths = \[(.*?)\]/ms.exec(templateClass ?? "")?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
	(m) => m[1],
);
if (!templateClass || !/^outcome = "owner"$/m.test(templateClass))
	failures.push('evf.toml: has no document-templates class with outcome = "owner"');
const templates = "packages/domain/src/documents/templates";
for (const name of readdirSync(join(root, templates)).filter((n) => n.endsWith(".json"))) {
	const file = `${templates}/${name}`;
	if (!owned.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)))
		failures.push(`${file}: is not in the document-templates owner class of evf.toml; add its exact path there`);
}

// AC:WP-029-15: only a real deployment sets VERCEL_ENV, so no CI workflow or package script sets it and opens the
// mail guard (packages/domain/src/mail-recipients.ts).
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
