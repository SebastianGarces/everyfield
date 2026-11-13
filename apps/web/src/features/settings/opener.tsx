"use client";

import { createContext, use, type MouseEvent } from "react";
import type { DialogSection } from "./model";

// Pages inside the product frame open a Settings section over themselves, as the rail and the user menu do, so Escape
// and Back return to that page. Outside the frame (no provider) a section link is an ordinary link.

const Opener = createContext<((section: DialogSection) => void) | null>(null);
export const SettingsOpener = Opener.Provider;

/** The link props for a Settings section: its address, and a plain click that opens it over the current page. */
export function useSettingsLink(section: DialogSection): {
	href: string;
	onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
	const open = use(Opener);
	return {
		href: `/settings/${section}`,
		onClick: (event) => {
			if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
			event.preventDefault();
			open(section);
		},
	};
}

/** Opens a Settings section over the current page; null outside the product frame. */
export function useOpenSettings(): ((section: DialogSection) => void) | null {
	return use(Opener);
}
