"use client";

import { useRef, useState } from "react";
import { EvryBot, type EvryMood } from "..";

export function EvryCheer() {
	const [mood, setMood] = useState<EvryMood>("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
