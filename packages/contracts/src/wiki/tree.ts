import type { SitePath } from "../identity/index.ts";

export const PHASE_NAME = [
	"Discovery",
	"Core Group Development",
	"Launch Team Formation",
	"Training & Preparation",
	"Pre-Launch",
	"Launch Sunday",
	"Post-Launch",
] as const;

export function articlePath(slug: string): SitePath {
	if (!slug) return "/wiki";
	return `/wiki/${slug
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
}

type NavArticle = { articleId: string; title: string; slug: string; phase: number | null; hidden: boolean };
type NavGroup = { name: string; articles: NavArticle[] };
type NavItem = { id: string; title: string; href: string; read: boolean; phase: number | null; hidden: boolean };

export type TreeModel = {
	phases: { number: number; name: string; items: NavItem[] }[];
	more: { name: string; items: NavItem[] }[];
};

export function treeModel(groups: NavGroup[], read: ReadonlySet<string>): TreeModel {
	const byPhase = new Map<number, NavItem[]>();
	const more: TreeModel["more"] = [];
	for (const group of groups) {
		const items = group.articles.map((article) => ({
			id: article.articleId,
			title: article.title,
			href: articlePath(article.slug),
			read: read.has(article.articleId),
			phase: article.phase,
			hidden: article.hidden,
		}));
		const journey = /^Journey ([0-6])$/.exec(group.name);
		if (journey?.[1]) {
			if (items.length) byPhase.set(Number(journey[1]), items);
		} else if (items.length) more.push({ name: group.name, items });
	}
	const phases = [...byPhase.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([number, items]) => ({ number, name: PHASE_NAME[number] ?? "Journey", items }));
	return { phases, more };
}

export const phaseLabel = (phase: number, name: string = PHASE_NAME[phase] ?? "Journey") => `Phase ${phase} · ${name}`;

export type TreeGroup = { label: string; phase: number | null; items: NavItem[] };

export function treeGroups(tree: TreeModel): TreeGroup[] {
	return [
		...tree.phases.map((phase) => ({
			label: phaseLabel(phase.number, phase.name),
			phase: phase.number,
			items: phase.items,
		})),
		...tree.more.map((group) => ({ label: group.name, phase: null, items: group.items })),
	];
}

const named = (text: string) =>
	text
		.toLowerCase()
		.replaceAll("&", " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

export function findGroup(groups: readonly TreeGroup[], section: string): TreeGroup | null {
	const wanted = named(section);
	const names = (group: TreeGroup) =>
		group.phase === null
			? [group.label]
			: [group.label, `Phase ${group.phase}`, String(group.phase), PHASE_NAME[group.phase] ?? ""];
	const empty = PHASE_NAME.map((name, phase) => ({ label: phaseLabel(phase, name), phase, items: [] }));
	return (
		[...groups, ...empty].find((group) =>
			names(group).some((name) => name !== "" && (named(name) === wanted || `${named(name)} section` === wanted)),
		) ?? null
	);
}

export type Step = { id: string; title: string; href: string; group: string };

export function stepsAround(tree: TreeModel, currentId: string): { previous: Step | null; next: Step | null } {
	const flat = treeGroups(tree).flatMap((group) =>
		group.items
			.filter((item) => !item.hidden || item.id === currentId)
			.map((item) => ({ id: item.id, title: item.title, href: item.href, group: group.label })),
	);
	const index = flat.findIndex((item) => item.id === currentId);
	if (index < 0) return { previous: null, next: null };
	const here = flat[index]?.group;
	const step = (item: (typeof flat)[number] | undefined): Step | null =>
		item ? { ...item, group: item.group === here ? "" : item.group } : null;
	return { previous: step(flat[index - 1]), next: step(flat[index + 1]) };
}

export function relatedArticles<A extends NavArticle>(
	groups: readonly { articles: readonly A[] }[],
	relatedIds: readonly string[],
): A[] {
	const byId = new Map(groups.flatMap((group) => group.articles).map((article) => [article.articleId, article]));
	return relatedIds.flatMap((id) => byId.get(id) ?? []);
}

type ReadCount = { done: number; total: number };

export function readCounts(tree: TreeModel): ReadCount & { phases: (ReadCount & { phase: number })[] } {
	const count = (items: readonly NavItem[]) => ({
		done: items.filter((item) => item.read).length,
		total: items.length,
	});
	return {
		...count(treeGroups(tree).flatMap((group) => group.items)),
		phases: tree.phases.map((phase) => ({ phase: phase.number, ...count(phase.items) })),
	};
}
