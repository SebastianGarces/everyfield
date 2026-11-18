import { cn } from "@everyfield/ui/foundations";
import Image from "next/image";
import type { CSSProperties } from "react";
import { PHOTOS, type Backdrop as Bg } from "./photos";

type Props = {
	bg: Bg;
	sizes: string;
	className?: string;
	style?: CSSProperties;
	preload?: boolean;
	shade?: number;
	zoom?: number;
};

export function Backdrop({ bg, sizes, className, style, preload, shade, zoom }: Props) {
	const crop = PHOTOS[bg];
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
