"use client";

import type { Loadable } from "@everyfield/ui/display";
import { useRead } from "../../../components/read.tsx";
import { errorReference } from "../model";
import type { BrandKit, BrandView } from "../port";
import { useReads } from "../store";
import { BRAND_ERROR_TEXT } from "./model";

export function useBrand(): {
	state: Loadable<BrandView>;
	setKit: (kit: BrandKit) => void;
	reload: () => Promise<BrandView | null>;
} {
	const reads = useReads();
	const read = useRead(reads.brand);
	const reply = read.value;
	const state: Loadable<BrandView> =
		reply === undefined
			? { status: "loading" }
			: reply.status === "ok"
				? { status: "ready", data: reply.value }
				: {
						status: "error",
						title: "The brand kit did not load",
						meta:
							reply.status === "refused"
								? `${BRAND_ERROR_TEXT[reply.error.code]} Reference ${errorReference(reply.error)}.`
								: "Everyfield could not be reached. Check your connection.",
						onRetry: read.retry,
					};
	return {
		state,
		setKit: (kit) =>
			reads.brand.patch((current) =>
				current.status === "ok" ? { ...current, value: { ...current.value, kit } } : current,
			),
		reload: () => reads.brand.refresh().then((next) => (next.status === "ok" ? next.value : null)),
	};
}
