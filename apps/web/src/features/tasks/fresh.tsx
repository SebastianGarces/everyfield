"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactElement, type ReactNode } from "react";

let outcomes = 0;
const shown = new WeakMap<object, number>();

export function outcomeSaved() {
	outcomes++;
}

export function Fresh({ loading, children }: { loading: ReactNode; children: ReactElement }) {
	const router = useRouter();
	const at = shown.get(children);
	const held = at !== undefined && at < outcomes;
	useEffect(() => {
		const first = shown.get(children);
		if (first === undefined) shown.set(children, outcomes);
		else if (first < outcomes) router.refresh();
	}, [children, router]);
	return held ? loading : children;
}
