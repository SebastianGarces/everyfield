"use client";

import { useEffect, useRef, useState } from "react";
import { EvryBot, type EvryMood } from "..";

/**
 * The idle specimen: an xl Evry that follows the pointer, as in the prototype. A click makes it happy for 1.4 s, the
 * prototype's greeting when the panel opens, so the preview shows a mood change on a mounted bot.
 */
export function EvryCheer() {
	const [mood, setMood] = useState<EvryMood>("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<button
			type="button"
			aria-label="Make Evry happy"
			className="rounded-full"
			onClick={() => {
				setMood("happy");
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setMood("idle"), 1400);
			}}
		>
			<EvryBot size="xl" mood={mood} follow />
		</button>
	);
}
