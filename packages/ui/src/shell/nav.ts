import type { IconSvgElement } from "../foundations";

/** A destination with its own page. `match: "exact"` is for a root page such as Overview, whose path prefixes every other page. */
export type ShellLink = {
	kind: "link";
	key: string;
	label: string;
	href: string;
	icon: IconSvgElement;
	match?: "exact" | "prefix";
	/** Runs on a plain click before the client navigation (next/link onNavigate). Settings prevents it and opens its
	 * dialog over the current page; a new tab or a fresh load still follows `href`. */
	onNavigate?: (event: { preventDefault: () => void }) => void;
};

/** A control that opens something over the page (Guide, Send feedback). `expanded` reports an open panel. */
export type ShellAction = {
	kind: "action";
	key: string;
	label: string;
	icon: IconSvgElement;
	onSelect: () => void;
	expanded?: boolean;
};

export type ShellItem = ShellLink | ShellAction;

/**
 * The destinations one person may reach, already filtered for their seat or relationship by the caller. The shell
 * shows exactly these items and decides no permission itself. `main` is the top navigation, `pages` the rail group
 * of further pages and `tools` the rail group at the bottom.
 */
export type ShellNav = { main: readonly ShellLink[]; pages: readonly ShellItem[]; tools: readonly ShellItem[] };

/** The person in the user menu. `detail` is the role line, such as "Lead planter · Harvest Point". */
export type ShellUser = { name: string; initials: string; detail: string };

function matches(link: ShellLink, pathname: string): boolean {
	if (link.match === "exact") return pathname === link.href;
	return pathname === link.href || pathname.startsWith(link.href + "/");
}

/** The key of the current page: the link with the longest href that matches the path, or null. */
export function currentKey(nav: ShellNav, pathname: string): string | null {
	let best: ShellLink | null = null;
	for (const item of [...nav.main, ...nav.pages, ...nav.tools]) {
		if (item.kind === "link" && matches(item, pathname) && (!best || item.href.length > best.href.length)) best = item;
	}
	return best?.key ?? null;
}
