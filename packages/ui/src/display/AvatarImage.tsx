"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../foundations";

/**
 * An avatar's photo, laid over the initials in the same circle. The initials show until the photo has loaded, and a
 * photo that fails or is refused unmounts, so the circle keeps the initials with no broken-image icon and no change of
 * size. Give it `key={src}` so a new version starts over.
 */
export function AvatarImage({ src }: { src: string }) {
	const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
	const ref = useRef<HTMLImageElement>(null);
	// An image that settled before hydration fired no React event: a complete image with no pixels failed.
	useEffect(() => {
		const img = ref.current;
		if (img?.complete) setState(img.naturalWidth > 0 ? "loaded" : "failed");
	}, []);
	if (state === "failed") return null;
	return (
		<img
			ref={ref}
			src={src}
			alt=""
			decoding="async"
			onLoad={() => setState("loaded")}
			onError={() => setState("failed")}
			className={cn("absolute inset-0 size-full bg-surface object-cover", state === "loading" && "opacity-0")}
		/>
	);
}
