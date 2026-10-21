import type { CSSProperties, ReactNode } from "react";
import { preload } from "react-dom";
import { cn } from "@/components/cn";
import { heroSources, photoSources, type Backdrop as Bg, type HeroPhoto, type MeshTone } from "./photos";

/** Full class names, so Tailwind finds them. */
const MESH: Record<MeshTone, string> = { field: "g-field", sky: "g-sky", sage: "g-sage", rose: "g-rose" };

type Layer = {
	/** Layout classes of the layer (position, inset, z-index, corners, mask). */
	className?: string;
	style?: CSSProperties;
	/** A deeper black overlay where cream text or icons sit on the photo (0.2 is the brand default). */
	shade?: number;
	/** Zooms into the crop's focus point (a small tile that shows a detail of its step's photo). */
	zoom?: number;
};

/**
 * A surface layer: a treated photo (the photo, a black overlay and film grain, foundations.md Marketing photos) or a muted
 * gradient (mk-gsurf). It is decorative (aria-hidden); the caller places it behind its content. The photo loads when it
 * nears the viewport (PhotoLoader); without JavaScript the noscript copy loads it natively.
 */
export function Backdrop({
	bg,
	sizes,
	...layer
}: Layer & {
	bg: Bg;
	/** The rendered width of the slot, for the browser's choice of file. Cover can need more than the slot width when
	 *  the slot is taller than the photo's shape; pass the width the photo covers. */
	sizes: string;
}) {
	if (bg.startsWith("mesh:"))
		return (
			<span
				aria-hidden="true"
				className={cn("mk-gsurf", MESH[bg.slice(5) as MeshTone], layer.className)}
				style={layer.style}
			/>
		);
	const { avif, jpeg, src, crop } = photoSources(bg as Exclude<Bg, `mesh:${string}`>);
	return (
		<PhotoLayer
			{...layer}
			pos={crop.pos}
			cropShade={crop.shade}
			cropZoom={crop.zoom}
			noscript={
				<picture>
					<source type="image/avif" srcSet={avif} sizes={sizes} />
					<img src={src} srcSet={jpeg} sizes={sizes} alt="" loading="lazy" decoding="async" />
				</picture>
			}
		>
			{/* PhotoLoader sets the sources when the photo nears the viewport. */}
			<source type="image/avif" data-srcset={avif} sizes={sizes} />
			{/* eslint-disable-next-line @next/next/no-img-element -- the <picture> is in PhotoLayer; the files are web-sized AVIF and JPEG copies */}
			<img data-src={src} data-srcset={jpeg} sizes={sizes} alt="" decoding="async" />
		</PhotoLayer>
	);
}

/** The page's hero photo: its small hero copy, loaded first and preloaded (the page's only preloaded image). */
export function HeroBackdrop({ photo, ...layer }: Layer & { photo: HeroPhoto }) {
	const { avif, src, crop } = heroSources(photo);
	preload(avif, { as: "image", type: "image/avif", fetchPriority: "high" });
	return (
		<PhotoLayer {...layer} pos={crop.pos} cropShade={crop.shade} cropZoom={crop.zoom}>
			<source type="image/avif" srcSet={avif} />
			{/* eslint-disable-next-line @next/next/no-img-element -- the <picture> is in PhotoLayer; the files are web-sized AVIF and JPEG copies */}
			<img src={src} alt="" fetchPriority="high" />
		</PhotoLayer>
	);
}

function PhotoLayer({
	className,
	style,
	shade,
	zoom,
	pos,
	cropShade,
	cropZoom,
	children,
	noscript,
}: Layer & { pos: string; cropShade?: number; cropZoom?: number; noscript?: ReactNode; children: ReactNode }) {
	// The crop as custom properties, so a slot can change it at a breakpoint (an important utility beats the inline value).
	const vars = { ...style, "--shade": shade ?? cropShade, "--pos": pos, "--zoom": zoom ?? cropZoom } as CSSProperties;
	return (
		<span aria-hidden="true" className={cn("mk-photo", className)} style={vars}>
			<picture>{children}</picture>
			{noscript ? <noscript>{noscript}</noscript> : null}
		</span>
	);
}
