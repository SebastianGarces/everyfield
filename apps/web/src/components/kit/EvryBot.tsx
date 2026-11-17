"use client";

import { EvryBot as Evry, type EvryMood } from "@everyfield/ui/foundations";
import type { MotionValue } from "motion/react";
import { useCallback, useSyncExternalStore } from "react";
import { cn } from "../cn";

type Props = { size: "sm" | "lg"; mood?: MotionValue<string>; follow?: boolean; className?: string };

const face = (v: string): EvryMood => (v === "happy" || v === "thinking" ? v : "idle");
const still = () => () => {};

function floatOutOfPhase(wrapper: HTMLSpanElement | null) {
	const bot = wrapper?.querySelector<HTMLElement>(".evry-bot");
	if (!bot) return;
	bot.style.setProperty("--eb-float", `${(3 + Math.random() * 1.2).toFixed(2)}s`);
	bot.style.setProperty("--eb-float-at", `${(-Math.random() * 4).toFixed(2)}s`);
}

export function EvryBot({ size, mood, follow, className }: Props) {
	const subscribe = useCallback((change: () => void) => mood?.on("change", change) ?? still(), [mood]);
	const current = useSyncExternalStore(
		subscribe,
		() => mood?.get() ?? "idle",
		() => "idle",
	);

	return (
		<span
			ref={floatOutOfPhase}
			data-evry-bot=""
			data-size={size}
			data-mood={current}
			aria-hidden="true"
			className={cn("relative inline-block flex-none align-middle", className)}
		>
			<Evry size={size} mood={face(current)} follow={follow} />
		</span>
	);
}
