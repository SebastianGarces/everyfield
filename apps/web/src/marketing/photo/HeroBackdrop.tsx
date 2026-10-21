import type { CSSProperties } from "react";
import { preload } from "react-dom";
import { cn } from "@/components/cn";
import type { Layer } from "./Backdrop";
import PHOTOS from "./photos.json";
import type { HeroPhoto } from "./photos";

/**
 * The page's hero photo, the LCP element: a 480 px AVIF of about 7 KB (scripts/render-hero-photos.mjs) with a 640 px
 * JPEG for browsers without AVIF. It loads first and is the page's only preloaded image.
 */
export function HeroBackdrop({ photo, className }: Pick<Layer, "className"> & { photo: HeroPhoto }) {
	const avif = `/photos/${photo}-hero.avif`;
	preload(avif, { as: "image", type: "image/avif", fetchPriority: "high" });
	return (
		<span
			aria-hidden="true"
			className={cn("mk-photo", className)}
			style={{ "--pos": PHOTOS[photo].pos } as CSSProperties}
		>
			<picture>
				<source type="image/avif" srcSet={avif} />
				<img src={`/photos/${photo}-640.jpg`} alt="" fetchPriority="high" />
			</picture>
		</span>
	);
}
