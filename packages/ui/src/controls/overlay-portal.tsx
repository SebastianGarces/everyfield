"use client";

import { useRef, useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * The element every overlay portals into: the page's <main> inside the product root, or the product root itself on
 * pages without one. Never <body>: product rules (font, focus ring, the dark variant and the light-token island) are
 * scoped to [data-product-root], so an overlay outside it would lose them. Inside <main>, an open menu or pop-over
 * also stays within a landmark (axe region). <main> creates no containing block or stacking context, so fixed
 * positioning and z-index work as they would at the root. Overlays open only after hydration, so the server value
 * (no container) never renders an open overlay.
 */
export function usePortalContainer(): HTMLElement | null {
	return useSyncExternalStore(
		subscribe,
		() =>
			document.querySelector<HTMLElement>("[data-product-root] main") ??
			document.querySelector<HTMLElement>("[data-product-root]"),
		() => null,
	);
}

type AutoFocusHandler = (event: Event) => void;

function openerOf(active: Element | null): HTMLElement | null {
	if (!(active instanceof HTMLElement) || active === document.body) return null;
	const button = active.closest('[role="menu"]')?.getAttribute("aria-labelledby");
	return (button && document.getElementById(button)) || active;
}

/**
 * Returns focus to the element that had it when the overlay opened. Radix restores focus only to its own Trigger, so
 * an overlay opened from caller state (a Guide button, a keyboard shortcut) would drop focus on <body> when it closes.
 * When onOpenAutoFocus runs, focus has not moved into the overlay yet, so the opener is still the active element.
 * The caller's own handlers run first; if one prevents the default, this hook leaves focus alone.
 * An overlay opened from a menu item returns focus to the menu's button, because the item is gone once its menu closes
 * (WAI-ARIA menu button pattern). A Radix menu is labelled by its button.
 */
export function useReturnFocus(own: { onOpenAutoFocus?: AutoFocusHandler; onCloseAutoFocus?: AutoFocusHandler } = {}) {
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus: (event: Event) => {
			opener.current = openerOf(document.activeElement);
			own.onOpenAutoFocus?.(event);
		},
		onCloseAutoFocus: (event: Event) => {
			own.onCloseAutoFocus?.(event);
			if (event.defaultPrevented) return;
			const target = opener.current;
			opener.current = null;
			if (target?.isConnected) {
				event.preventDefault();
				target.focus({ preventScroll: true });
			}
		},
	};
}
