"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Marks each photo slot data-seen when it comes within half a viewport, and the stylesheet then draws its photo (mk-photo).
 * Native lazy loading starts images up to 1250 px below the screen on phones, where they compete with the hero and the
 * fonts for the first paint. Slots in a hidden layout (the phone or desk copy of a chapter) never intersect, so their
 * photos never load. Without JavaScript the stylesheet draws every photo at once.
 */
export function PhotoLoader() {
	const path = usePathname();
	useEffect(() => {
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					e.target.setAttribute("data-seen", "");
					io.unobserve(e.target);
				}
			},
			{ rootMargin: "50% 0px" },
		);
		document.querySelectorAll("[data-photo]:not([data-seen])").forEach((el) => io.observe(el));
		return () => io.disconnect();
	}, [path]);
	return null;
}
