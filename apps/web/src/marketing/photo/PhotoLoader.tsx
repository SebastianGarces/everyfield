"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Loads each page photo when it comes within half a viewport (Backdrop renders its sources as data-src and data-srcset).
 * Native lazy loading starts images up to 1250 px below the screen on phones, so photos under the hero competed with the
 * hero photo and the fonts for the first paint. Photos in hidden layouts (the phone or desk copy of a chapter) never
 * intersect, so they never load. Without JavaScript, Backdrop's noscript copy shows the photo.
 */
export function PhotoLoader() {
	const path = usePathname();
	useEffect(() => {
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					const img = e.target as HTMLImageElement;
					const avif = img.previousElementSibling as HTMLSourceElement | null;
					if (avif?.dataset.srcset) avif.srcset = avif.dataset.srcset;
					img.srcset = img.dataset.srcset ?? "";
					img.src = img.dataset.src ?? "";
					io.unobserve(img);
				}
			},
			{ rootMargin: "50% 0px" },
		);
		document.querySelectorAll<HTMLImageElement>("img[data-src]:not([src])").forEach((img) => io.observe(img));
		return () => io.disconnect();
	}, [path]);
	return null;
}
