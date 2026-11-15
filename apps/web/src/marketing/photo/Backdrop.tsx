import Image from "next/image";
import type { CSSProperties } from "react";
import { cn } from "@/components/cn";
import { PHOTOS, type Backdrop as Bg } from "./photos";

type Props = {
	bg: Bg;
	/** The rendered width of the slot, for the browser's choice of file. Cover can need more than the slot width when the
	 *  slot is taller than the photo's shape; pass the width the photo covers. */
	sizes: string;
	/** Layout classes of the layer (position, inset, z-index, mask). */
	className?: string;
	style?: CSSProperties;
	/** The page's hero photo: preloaded at high priority. Every other photo loads lazily. */
	preload?: boolean;
	/** A deeper black overlay where cream text or icons sit on the photo (0.2 is the brand default). */
	shade?: number;
	/** Zooms into the crop's focus point (a small tile that shows a detail of its step's photo). */
	zoom?: number;
};

/**
 * A surface layer: a treated photo (next/image, then a black overlay and film grain in CSS; foundations.md Marketing
 * photos). It is decorative (aria-hidden); the caller places it behind its content.
 */
export function Backdrop({ bg, sizes, className, style, preload, shade, zoom }: Props) {
	const crop = PHOTOS[bg];
	// The crop as custom properties, so a slot can change it at a breakpoint (an important utility beats the inline value).
	const vars = {
		...style,
		"--pos": crop.pos,
		"--shade": shade ?? ("shade" in crop ? crop.shade : undefined),
		"--zoom": zoom ?? ("zoom" in crop ? crop.zoom : undefined),
	} as CSSProperties;
	return (
		<span aria-hidden="true" className={cn("mk-photo", className)} style={vars}>
			<Image src={crop.src} alt="" fill sizes={sizes} quality={70} preload={preload} />
		</span>
	);
}
