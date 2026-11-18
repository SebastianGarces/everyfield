import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	appRoutes,
	changedFiles,
	featureMapFile,
	featureOf,
	isTest,
	loadMaps,
	PENDING_FILE,
	SCHEMA_FILE,
	type FeatureMap,
} from "./feature-maps.ts";
import { census, chartCurrent, page, render, SCHEMA_TABLES, sameValues, schemaColumns, tableFile } from "./machines.ts";
import { columnsOf, machines } from "../../packages/contracts/src/machines/index.ts";

type Surface = FeatureMap["surfaces"][number];
type Reach = Surface["reach"][number];
export type ProofResult = { problems: string[]; needed: boolean; report: string };

const WIDTHS = [390, 1440] as const;
const RECORDING = /\.(webm|mp4|mov)$/;
const PNG_SIGNATURE = "89504e470d0a1a0a";
const NOT_PRODUCT = new Set([PENDING_FILE, SCHEMA_FILE]);

const isProduct = (file: string) =>
	(file.startsWith("apps/web/") || /^packages\/[^/]+\/src\//.test(file)) &&
	!NOT_PRODUCT.has(file) &&
	!file.endsWith(".md") &&
	!isTest(file) &&
	!/\.spec\.|(^|\/)(tests?|__tests__)\//.test(file);

function pngWidth(file: string): number | null {
	const bytes = readFileSync(file);
	if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return null;
	return bytes.readUInt32BE(16);
}

const cell = (text: string) => text.replace(/\|/g, "\\|");
const personaList = (ids: string[]) => ids.map((p) => `\`${p}\``).join(", ");

function reachText(reach: Reach): string {
	if ("rail" in reach) return `${personaList(reach.personas)}: rail "${reach.rail}"`;
	if ("from" in reach) {
		const clicks = reach.path.flatMap((s) =>
			"click" in s ? ["role" in s.click ? `${s.click.role} "${s.click.name}"` : `"${s.click.text}"`] : [],
		);
		return `${personaList([reach.persona])}: from ${reach.from}${clicks.length ? `, click ${clicks.join(", then ")}` : ""}`;
	}
	return reach.email ? `email \`${reach.email}\` links to \`${reach.link}\`` : `link \`${reach.link}\``;
}

function provesText(surface: Surface): string {
	if (!surface.behaviors.length) return "no behavior mapped yet";
	return surface.behaviors
		.map((b) => {
			const parts = [
				...b.proof.tests.map((t) => `test \`${t.file}\`: ${t.name}`),
				...(b.proof.cases?.length ? [`cases ${b.proof.cases.join(", ")}`] : []),
				...(b.proof.browser ? [`browser ${b.proof.browser.kind} proof from state ${b.proof.browser.state}`] : []),
			];
			return `**#${b.id}**: ${parts.join("; ")}`;
		})
		.join("<br>");
}

function machineProof(root: string, changed: string[], evidence: string, base?: string) {
	const problems: string[] = [];
	const rows: string[] = [];
	const changes = new Set(changed);
	const schema = changes.has(SCHEMA_TABLES) ? schemaColumns(root, base) : undefined;
	for (const m of machines) {
		const key = `${m.table}.${m.column}`;
		const writers = census(root, m);
		const touched =
			changes.has(tableFile(m)) ||
			(schema !== undefined &&
				columnsOf(m).some(
					(c) => !sameValues(schema.head.get(`${m.table}.${c}`), schema.before.get(`${m.table}.${c}`)),
				)) ||
			writers.some((w) => changes.has(w.file));
		if (!touched) continue;
		if (!chartCurrent(root, m, render(m, writers)))
			problems.push(`${m.id}: ${page(m)} is missing or differs from its table; run node tools/ci/machines.ts --write.`);
		const name = `${m.id}-coverage.txt`,
			file = join(evidence, name);
		let summary = "none";
		if (!existsSync(file))
			problems.push(
				`${m.id}: ${file} is missing; run ${m.proof} with EVF_MACHINE_COVERAGE set, then node tools/ci/machines.ts coverage <file> > ${file}.`,
			);
		else {
			const lines = readFileSync(file, "utf8").split("\n");
			const at = lines.findIndex((l) => l.startsWith(`${m.id}: `));
			const line = lines[at];
			const rest = lines.slice(at + 1),
				end = rest.findIndex((l) => !/^\s+missing:/.test(l));
			const missing = end < 0 ? rest : rest.slice(0, end);
			if (line === undefined) problems.push(`${m.id}: ${file} has no "${m.id}:" coverage line.`);
			else if (missing.length || [...line.matchAll(/(\d+)\/(\d+)/g)].some(([, seen, all]) => seen !== all))
				problems.push(
					`${m.id}: ${file} does not show every edge, stay, refusal and state: ${[line, ...missing].map((l) => l.trim()).join("; ")}`,
				);
			else summary = `[${name}](${name}): ${line.slice(m.id.length + 2)}`;
		}
		rows.push(
			`| ${m.id} | \`${key}\` | [${tableFile(m)}](${tableFile(m)}) | [${page(m)}](${page(m)}) | ${cell(summary)} |`,
		);
	}
	const report = rows.length
		? [
				"### Machines",
				"",
				"| Machine | Column | Table | Chart | Coverage |",
				"|---|---|---|---|---|",
				...rows,
				"",
			].join("\n")
		: "";
	return { problems, report };
}

export function reviewProof(
	root: string,
	changed: string[],
	evidence: string,
	proved: string[],
	base?: string,
): ProofResult {
	const problems: string[] = [];
	const loaded = loadMaps(root);
	problems.push(...loaded.problems);
	const surfaces = new Map<string, { surface: Surface; feature: string }>();
	const owner = new Map<string, string>();
	for (const { map } of loaded.maps)
		for (const surface of map.surfaces) {
			surfaces.set(surface.id, { surface, feature: map.feature });
			for (const url of [...surface.routes, ...(surface.endpoints ?? [])]) owner.set(url, surface.id);
		}
	const routeOf = new Map(appRoutes(root).map((r) => [r.file, r.url] as const));

	const exact = new Set<string>();
	const features = new Map<string, string[]>();
	const other: string[] = [];
	for (const file of changed.filter(isProduct)) {
		const surface = owner.get(routeOf.get(file) ?? "");
		const feature = featureOf(file);
		if (surface) exact.add(surface);
		else if (feature && existsSync(join(root, featureMapFile(feature))))
			features.set(feature, [...(features.get(feature) ?? []), file]);
		else other.push(file);
	}
	const needed = exact.size > 0 || features.size > 0 || other.length > 0;

	const known = [...new Set(proved)].filter((id) => {
		if (surfaces.has(id)) return true;
		problems.push(`${id}: is no surface in any feature map; surfaces: ${[...surfaces.keys()].join(", ")}`);
		return false;
	});
	const required = [...new Set([...exact, ...known])].sort();
	for (const [feature, files] of features)
		if (!required.some((id) => surfaces.get(id)!.feature === feature))
			problems.push(
				`${feature}: the diff changes ${files.join(", ")}; prove at least one of its surfaces: ${[...surfaces.values()]
					.filter((s) => s.feature === feature)
					.map((s) => s.surface.id)
					.join(", ")}`,
			);
	if (other.length && required.length === 0)
		problems.push(
			`the diff changes product code that no mapped surface owns (${other.join(", ")}); prove at least one surface it affects`,
		);

	const rows: string[] = [];
	for (const id of required) {
		const dir = join(evidence, "proof", id);
		const files = existsSync(dir) ? readdirSync(dir).sort() : [];
		const found: string[] = [];
		const widths = new Set<number>();
		let recorded = false;
		for (const name of files) {
			const path = join(dir, name);
			const rel = `proof/${id}/${name}`;
			if (name.endsWith(".png")) {
				const width = pngWidth(path);
				if (width === null) problems.push(`${rel}: is not a PNG`);
				else if (!(WIDTHS as readonly number[]).includes(width))
					problems.push(`${rel}: is ${width} px wide; a proof shot is the true 390 or 1440 px viewport`);
				else {
					widths.add(width);
					found.push(`[${name}](${rel}) (${width} px)`);
				}
			} else if (RECORDING.test(name) && statSync(path).size > 0) {
				recorded = true;
				found.push(`[${name}](${rel}) (recording)`);
			}
		}
		if (!recorded)
			for (const width of WIDTHS)
				if (!widths.has(width))
					problems.push(`${id}: has no ${width} px screenshot and no recording in ${join(evidence, "proof", id)}/`);
		const { surface, feature } = surfaces.get(id)!;
		const access = Object.entries(surface.personas)
			.map(([p, a]) => `\`${p}\` ${a}`)
			.join(", ");
		rows.push(
			`| ${id} | ${feature} | ${cell([...surface.reach.map(reachText), `access: ${access}`].join("<br>"))} | ${cell(provesText(surface))} | ${cell(found.join("<br>") || "none")} |`,
		);
	}

	const report = rows.length
		? [
				"| Surface | Feature | How users reach it | What proves it | Screenshots or recording |",
				"|---|---|---|---|---|",
				...rows,
				"",
			].join("\n")
		: needed
			? ""
			: `No app proof needed: the diff changes only tooling, docs, tests or agent instructions (${changed.length} file(s)).\n`;
	const machine = machineProof(root, changed, evidence, base);
	problems.push(...machine.problems);
	return {
		problems: [...new Set(problems)],
		needed,
		report: report + (report && machine.report ? "\n" : "") + machine.report,
	};
}

if (import.meta.main) {
	const usage =
		"Usage: node tools/ci/review-proof.ts --base <merge-base sha> --evidence <dir> [--head <checkout>] [<surface-id>...]";
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: { base: { type: "string" }, head: { type: "string" }, evidence: { type: "string" } },
		});
	} catch (error) {
		console.error(`${(error as Error).message}\n${usage}`);
		process.exit(2);
	}
	const { base, head = process.cwd(), evidence } = parsed.values;
	if (!base || !evidence) {
		console.error(usage);
		process.exit(2);
	}
	const { problems, needed, report } = reviewProof(
		head,
		changedFiles(head, base, "HEAD"),
		evidence,
		parsed.positionals,
		base,
	);
	process.stdout.write(report);
	for (const p of problems) console.error(p);
	if (problems.length) {
		console.error(`review-proof: ${problems.length} problem(s); do not approve until each is fixed.`);
		process.exit(1);
	}
	console.log(needed ? "review-proof: every required surface is proved." : "review-proof: no app proof needed.");
}
