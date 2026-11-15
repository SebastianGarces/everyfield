"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../foundations";

export function AvatarImage({ src }: { src: string }) {
	const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
	const ref = useRef<HTMLImageElement>(null);
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
