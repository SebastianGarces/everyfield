import type { IconSvgElement } from "../foundations";

export type ShellLink = {
	kind: "link";
	key: string;
	label: string;
	href: string;
	icon: IconSvgElement;
	match?: "exact" | "prefix";
	onNavigate?: (event: { preventDefault: () => void }) => void;
	prefetch?: false;
};

export const linkPrefetch = (link: ShellLink) => (link.onNavigate || link.prefetch === false ? false : undefined);

export type ShellAction = {
	kind: "action";
	key: string;
	label: string;
	icon: IconSvgElement;
	onSelect: () => void;
	expanded?: boolean;
};

export type ShellItem = ShellLink | ShellAction;

export type ShellNav = { main: readonly ShellLink[]; pages: readonly ShellItem[]; tools: readonly ShellItem[] };

export type ShellUser = {
	name: string;
	initials: string;
	detail: string;
	photo?: string;
};

function matches(link: ShellLink, pathname: string): boolean {
	if (link.match === "exact") return pathname === link.href;
	return pathname === link.href || pathname.startsWith(link.href + "/");
}

export function currentKey(nav: ShellNav, pathname: string): string | null {
	let best: ShellLink | null = null;
	for (const item of [...nav.main, ...nav.pages, ...nav.tools]) {
		if (item.kind === "link" && matches(item, pathname) && (!best || item.href.length > best.href.length)) best = item;
	}
	return best?.key ?? null;
}
