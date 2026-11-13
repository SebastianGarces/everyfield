"use client";

import type { Loadable } from "@everyfield/ui/display";
import { useCallback, useEffect, useState } from "react";
import { errorReference } from "../model";
import type { BrandKit, BrandView } from "../port";
import { useFlowState, useSeed, useSettings } from "../store";
import { BRAND_ERROR_TEXT } from "./model";

/**
 * Loads the brand kit and the church name through the port and keeps the last value in the settings store, so
 * switching sections and back shows it at once. A fresh load of /settings/brand uses the read the server started with
 * the page. `setKit` stores a kit a save or reset returned; `reload` reads the current kit (Load latest).
 */
export function useBrand(): {
	state: Loadable<BrandView>;
	setKit: (kit: BrandKit) => void;
	reload: () => void;
} {
	const { port } = useSettings();
	const seed = useSeed();
	const [view, setView] = useFlowState<BrandView | null>("brand.view", null);
	// A failure belongs to one attempt, so a retry never shows an old failure.
	const [failure, setFailure] = useState<{ attempt: number; meta: string } | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (view && attempt === 0) return;
		let live = true;
		const seeded = attempt === 0 && seed && "brand" in seed ? seed.brand : null;
		Promise.resolve(seeded ?? port.brand.get()).then(
			(reply) => {
				if (!live) return;
				if (reply.status === "ok") setView(reply.value);
				else
					setFailure({
						attempt,
						meta: `${BRAND_ERROR_TEXT[reply.error.code]} Reference ${errorReference(reply.error)}.`,
					});
			},
			() => live && setFailure({ attempt, meta: "Everyfield could not be reached. Check your connection." }),
		);
		return () => {
			live = false;
		};
		// The stored value and the seed are read once; a reload bumps the attempt.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [port, attempt, setView]);

	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const setKit = useCallback((kit: BrandKit) => setView((prev) => prev && { ...prev, kit }), [setView]);
	const failed = failure && failure.attempt === attempt ? failure : null;
	const state: Loadable<BrandView> = failed
		? { status: "error", title: "The brand kit did not load", meta: failed.meta, onRetry: reload }
		: view
			? { status: "ready", data: view }
			: { status: "loading" };
	return { state, setKit, reload };
}
