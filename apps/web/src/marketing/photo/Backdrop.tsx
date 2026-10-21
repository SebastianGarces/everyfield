import type { CSSProperties } from "react";
import { cn } from "@/components/cn";
import type { Backdrop as Bg, MeshTone } from "./photos";

/** Full class names, so Tailwind finds them. */
const MESH: Record<MeshTone, string> = { field: "g-field", sky: "g-sky", sage: "g-sage", rose: "g-rose" };

export type Layer = {
	/** Layout classes of the layer (position, inset, z-index, mask). */
	className?: string;
	style?: CSSProperties;
	/** A deeper black overlay where cream text or icons sit on the photo (0.2 is the brand default). */
	shade?: number;
	/** Zooms into the crop's focus point (a small tile that shows a detail of its step's photo). */
	zoom?: number;
};

/**
 * A surface layer: a treated photo (the photo, a black overlay and film grain, foundations.md Marketing photos) or a muted
 * gradient (mk-gsurf). One decorative span: the stylesheet draws the photo (mk-photo, photos.generated.css) once
 * PhotoLoader sees it near the viewport. The caller places it behind its content.
 */
export function Backdrop({ bg, className, style, shade, zoom }: Layer & { bg: Bg }) {
	if (bg.startsWith("mesh:"))
		return (
			<span aria-hidden="true" className={cn("mk-gsurf", MESH[bg.slice(5) as MeshTone], className)} style={style} />
		);
	return (
		<span
			aria-hidden="true"
			data-photo={bg}
			className={cn("mk-photo", className)}
			style={{ ...style, "--shade": shade, "--zoom": zoom } as CSSProperties}
		/>
	);
}
