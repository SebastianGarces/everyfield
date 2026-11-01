"use client";

import { EvryBot as Evry, type EvryMood } from "@everyfield/ui/foundations";
import type { MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { cn } from "../cn";
import { useDataAttr } from "../motion/scene";

// Evry on the landing pages: the approved character (OPS-84) from @everyfield/ui/foundations, which owns the geometry
// (EvryGeo) and the one life loop every bot on the page shares. This wrapper only connects the scene clock: the mood
// arrives as the root's data-mood attribute (written by useDataAttr, or by a test), and the bot follows it. `talking`
// and any unknown mood render as idle; the prototype has no talking animation (WP-097 decision).

type Props = { size: "sm" | "lg"; mood?: MotionValue<string>; follow?: boolean; className?: string };

const face = (v: string | null): EvryMood => (v === "happy" || v === "thinking" ? v : "idle");

export function EvryBot({ size, mood, follow, className }: Props) {
	const ref = useRef<HTMLSpanElement>(null);
	const subscribe = useCallback((change: () => void) => {
		const watch = new MutationObserver(change);
		watch.observe(ref.current!, { attributes: true, attributeFilter: ["data-mood"] });
		return () => watch.disconnect();
	}, []);
	const shown = useSyncExternalStore(
		subscribe,
		() => face(ref.current?.getAttribute("data-mood") ?? null),
		() => "idle" as const,
	);

	// The float period (3 to 4.2 s) and phase are random per bot, set after mount so the server and the first client
	// render match. React leaves these two properties alone: the package bot's own values for them never change here.
	useEffect(() => {
		const bot = ref.current!.querySelector<HTMLElement>(".evry-bot")!;
		bot.style.setProperty("--eb-float", `${(3 + Math.random() * 1.2).toFixed(2)}s`);
		bot.style.setProperty("--eb-float-at", `${(-Math.random() * 4).toFixed(2)}s`);
	}, []);

	return (
		<span
			ref={ref}
			data-evry-bot=""
			data-size={size}
			data-mood="idle"
			aria-hidden="true"
			className={cn("relative inline-block flex-none align-middle", className)}
		>
			{mood ? <Mood target={ref} mood={mood} /> : null}
			<Evry size={size} mood={shown} follow={follow} />
		</span>
	);
}

function Mood({ target, mood }: { target: RefObject<HTMLSpanElement | null>; mood: MotionValue<string> }) {
	useDataAttr(target, "data-mood", mood);
	return null;
}
