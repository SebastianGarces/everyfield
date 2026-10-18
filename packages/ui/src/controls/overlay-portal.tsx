"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * The element every overlay portals into: the product root, not <body>. Product rules (font, focus ring, the dark
 * variant and the light-token island) are scoped to [data-product-root], so an overlay outside it would lose them.
 * Overlays open only after hydration, so the server value (no container) never renders an open overlay.
 */
export function usePortalContainer(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => document.querySelector<HTMLElement>("[data-product-root]"),
    () => null,
  );
}
