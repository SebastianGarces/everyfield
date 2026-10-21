import type { CSSProperties } from "react";
import { preload } from "react-dom";
import { cn } from "@/components/cn";
import { photoSources, type Backdrop as Bg, type MeshTone } from "./photos";

/** Full class names, so Tailwind finds them. */
const MESH: Record<MeshTone, string> = { field: "g-field", sky: "g-sky", sage: "g-sage", rose: "g-rose" };

type Props = {
	bg: Bg;
	/** Layout classes of the layer (position, inset, z-index, corners, mask). */
	className?: string;
	style?: CSSProperties;
	/** The rendered width of the slot, for the browser's choice of file. Cover can need more than the slot width when
	 *  the slot is taller than the photo's shape; pass the width the photo covers. */
	sizes: string;
	/** The page's hero photo: loads first and is preloaded. Every other photo loads when it nears the viewport. */
	priority?: boolean;
	/** A deeper black overlay where cream text or icons sit on the photo (0.2 is the brand default). */
	shade?: number;
	/** Zooms into the crop's focus point (a small tile that shows a detail of its step's photo). */
	zoom?: number;
};

/**
 * A surface layer: a treated photo (the photo, a black overlay and film grain, foundations.md Marketing photos) or a muted
 * gradient (mk-gsurf). It is decorative (aria-hidden); the caller places it behind its content.
 */
export function Backdrop({ bg, className, style, sizes, priority, shade, zoom }: Props) {
	if (bg.startsWith("mesh:"))
		return <span aria-hidden="true" className={cn("mk-gsurf", MESH[bg.slice(5) as MeshTone], className)} style={style} />;
	const { avif, jpeg, src, crop } = photoSources(bg as Exclude<Bg, `mesh:${string}`>);
	if (priority)
		preload(src, { as: "image", type: "image/avif", imageSrcSet: avif, imageSizes: sizes, fetchPriority: "high" });
	// The crop as custom properties, so a slot can change it at a breakpoint (an important utility beats the inline value).
	const layer = { ...style, "--shade": shade ?? crop.shade, "--pos": crop.pos, "--zoom": zoom ?? crop.zoom } as CSSProperties;
	return (
		<span aria-hidden="true" className={cn("mk-photo", className)} style={layer}>
			<picture>
				<source type="image/avif" srcSet={avif} sizes={sizes} />
				<img
					src={src}
					srcSet={jpeg}
					sizes={sizes}
					alt=""
					loading={priority ? "eager" : "lazy"}
					fetchPriority={priority ? "high" : undefined}
					decoding="async"
				/>
			</picture>
		</span>
	);
}
