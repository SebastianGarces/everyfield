"use client";

import { useCallback, useState } from "react";
import { cn } from "../foundations";

export function AvatarImage({ src }: { src: string }) {
	const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
	const settledBeforeHydration = useCallback((img: HTMLImageElement | null) => {
		if (img?.complete) setState(img.naturalWidth > 0 ? "loaded" : "failed");
	}, []);
	if (state === "failed") return null;
	return (
		<img
			ref={settledBeforeHydration}
			src={src}
			alt=""
			decoding="async"
			onLoad={() => setState("loaded")}
			onError={() => setState("failed")}
			className={cn("absolute inset-0 size-full bg-surface object-cover", state === "loading" && "opacity-0")}
		/>
	);
}
