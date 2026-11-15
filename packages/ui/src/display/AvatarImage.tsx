"use client";

import { useState } from "react";
import { cn } from "../foundations";

export type ImageSettled = "loaded" | "failed";

function replaySettledBeforeHydration(img: HTMLImageElement | null) {
	if (img?.complete) img.dispatchEvent(new Event(img.naturalWidth > 0 ? "load" : "error"));
}

export function AvatarImage({ src, onSettled }: { src: string; onSettled?: (result: ImageSettled) => void }) {
	const [state, setState] = useState<"loading" | ImageSettled>("loading");
	const settle = (result: ImageSettled) => {
		setState(result);
		onSettled?.(result);
	};
	if (state === "failed") return null;
	return (
		<img
			ref={replaySettledBeforeHydration}
			src={src}
			alt=""
			decoding="async"
			onLoad={() => settle("loaded")}
			onError={() => settle("failed")}
			className={cn("absolute inset-0 size-full bg-surface object-cover", state === "loading" && "opacity-0")}
		/>
	);
}
