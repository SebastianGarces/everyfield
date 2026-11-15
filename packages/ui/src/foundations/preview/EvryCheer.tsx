"use client";

import { useState } from "react";
import { EvryBot } from "..";

export function EvryCheer() {
	const [happy, setHappy] = useState(false);
	return (
		<button
			type="button"
			aria-label="Make Evry happy"
			aria-pressed={happy}
			className="rounded-full"
			onClick={() => setHappy((h) => !h)}
		>
			<EvryBot size="xl" mood={happy ? "happy" : "idle"} follow />
		</button>
	);
}
