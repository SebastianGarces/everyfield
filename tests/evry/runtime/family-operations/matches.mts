import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import {
	COMPOSE_READS,
	READ_DRAFT,
	READ_REVIEW,
	SELECT_RETURNED_ROWS,
	UPDATE_DRAFT,
} from "../../../../packages/evry/src/catalog/catalog.ts";
import { READ_DOMAINS } from "../../../../packages/evry/src/index.ts";
import { REVIEWED_WRITES } from "../../../../packages/evry/src/proposals/review.ts";

export const ROOT = new URL("../../../../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

export type Tested = { file: string; test: string; operations: string[]; through?: Record<string, string> };
export type Excluded = { rule: string; authority: string[]; operations: string[] };
export type Withheld = { decision: string; operations: string[] };
export type Family = { family: string; tested: Tested[]; excluded: Excluded[]; withheld: Withheld[] };
export type Operation = {
	id: string;
	evry: boolean;
	model_tool: boolean;
	authority: { actors: string[]; rule: string }[];
};

type Case = { id: string; operation_ids?: string[]; action: { arguments: { operation_matrix?: string[] } } };
const cases: Case[] = JSON.parse(text("docs/acceptance/evry.json")).cases;
export const MATRICES = new Map(
	cases
		.filter((c) => c.id.startsWith("EVRY-FAMILY-"))
		.map((c) => [c.id, c.action.arguments.operation_matrix ?? []] as const),
);
export const CATALOG = new Map<string, Operation>(
	(JSON.parse(text("docs/catalog/operations.json")).operations as Operation[]).map((o) => [o.id, o]),
);
const RULES = new Set<string>(
	[...text("docs/catalog/requirements/evry.json").matchAll(/"id": "(REQ-EVR-\d+)"/g)].map((m) => m[1]!),
);
export const SHIPPED = new Set<string>([
	...Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
	...Object.keys(REVIEWED_WRITES),
	SELECT_RETURNED_ROWS,
	COMPOSE_READS,
	READ_DRAFT,
	UPDATE_DRAFT,
	READ_REVIEW,
]);

export const FAMILIES: Family[] = readdirSync(new URL(".", import.meta.url))
	.filter((f) => f.endsWith(".json"))
	.sort()
	.map((f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")));

const chunks = (source: string) => source.split(/^(?=[^\s})\]])/m);
const TITLE = /\b(?:test|it)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
const sources = new Map<string, { chunks: string[]; titles: { title: string; chunk: number }[] } | null>();
function source(file: string) {
	if (!sources.has(file)) {
		const url = new URL(file, ROOT);
		if (!existsSync(url)) sources.set(file, null);
		else {
			const parts = chunks(readFileSync(url, "utf8"));
			sources.set(file, {
				chunks: parts,
				titles: parts.flatMap((part, chunk) => [...part.matchAll(TITLE)].map((m) => ({ title: m[2]!, chunk }))),
			});
		}
	}
	return sources.get(file)!;
}
function reached(parts: string[], from: number) {
	const declared = parts.map((p) => /^(?:export )?(?:async )?(?:const|let|function) \{? ?([\w, :]+)/.exec(p)?.[1]);
	const seen = new Set([from, ...parts.flatMap((p, i) => (/^before\(/.test(p) ? [i] : []))]);
	for (const at of seen)
		declared.forEach((names, i) => {
			if (!seen.has(i) && names?.split(/\W+/).some((n) => n && new RegExp(`\\b${n}\\b`).test(parts[at]!))) seen.add(i);
		});
	const body = [...seen].map((i) => parts[i]!).join("\n");
	const data = new Set([...body.matchAll(/"(?:\.\/)?([\w-]+\.cases\.json)"/g)].map((m) => `tests/evry/evals/${m[1]!}`));
	return [body, ...[...data].map(text)].join("\n");
}
const SUITES = [
	...[...text("packages/evry/package.json").matchAll(/\.\.\/\.\.\/(tests\/[^\s"]+)/g)].map((m) => m[1]!),
	...(JSON.parse(text("tests/integration/writes/suites.json")) as string[]),
].flatMap((glob) => globSync(glob, { cwd: ROOT }));
const inCi = new Set(SUITES);

const mentions = (body: string, token: string) =>
	new RegExp(`(?<![\\w.])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w]|\\.\\w)`).test(body);

export function problems(
	families: Family[],
	matrices = MATRICES,
	catalog = CATALOG,
	shipped: ReadonlySet<string> = SHIPPED,
): string[] {
	const out: string[] = [];
	for (const id of matrices.keys()) if (!families.some((f) => f.family === id)) out.push(`${id} has no matches`);
	for (const { family, tested, excluded, withheld } of families) {
		const matrix = new Set(matrices.get(family) ?? []);
		const matched = [...tested, ...excluded, ...withheld].flatMap((m) => m.operations);
		for (const id of matrix) if (!matched.includes(id)) out.push(`${family} ${id} is not matched`);
		for (const id of matched) if (!matrix.has(id)) out.push(`${family} ${id} is not in the matrix`);
		for (const [i, id] of matched.entries())
			if (matched.indexOf(id) !== i) out.push(`${family} ${id} is matched twice`);
		for (const { file, test, operations, through = {} } of tested) {
			const found = source(file);
			const named = found?.titles.filter((t) => t.title.startsWith(test)) ?? [];
			if (named.length !== 1) {
				out.push(`${family} ${file} "${test}" names ${named.length} tests`);
				continue;
			}
			if (!inCi.has(file)) out.push(`${family} ${file} is in no CI suite`);
			const body = reached(found!.chunks, named[0]!.chunk);
			for (const id of operations) {
				const token = through[id] ?? id;
				if (catalog.get(id)?.model_tool && !shipped.has(token.split(" ")[0]!))
					out.push(`${family} ${id} is a model tool that ${token} does not serve`);
				if (!mentions(body, token.split(" ").at(-1)!)) out.push(`${family} ${id}: "${test}" never names ${token}`);
			}
			for (const id of Object.keys(through))
				if (!operations.includes(id)) out.push(`${family} ${id} is served but not listed`);
		}
		for (const { rule, authority, operations } of excluded) {
			if (!RULES.has(rule)) out.push(`${family} ${rule} is no catalog rule`);
			for (const id of operations) {
				const op = catalog.get(id);
				if (!op) continue;
				if (op.model_tool) out.push(`${family} ${id} is a model tool and cannot be excluded`);
				if (op.evry && !op.model_tool) out.push(`${family} ${id} is Evry's own protocol and cannot be excluded`);
				const actors = op.authority.flatMap((a) => a.actors);
				if (JSON.stringify([...new Set(actors)].sort()) !== JSON.stringify([...authority].sort()))
					out.push(`${family} ${id} is for ${actors.join(", ")}, not ${authority.join(", ")}`);
			}
		}
		for (const { decision, operations } of withheld) {
			if (!/^(D-\d+|T-\d+)\b/.test(decision)) out.push(`${family} "${decision}" cites no decision`);
			for (const id of operations) if (shipped.has(id)) out.push(`${family} ${id} is shipped and cannot be withheld`);
		}
	}
	return out;
}
