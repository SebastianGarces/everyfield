"use client";

import type { AssetSlot } from "@everyfield/contracts/branding";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorReference } from "../model";
import type { BrandKit, BrandPort, SuggestedColors } from "../port";
import { useFlowState } from "../store";
import {
	ALT_REQUIRED,
	altProblem,
	assetMessage,
	canSuggest,
	fileProblem,
	removeAsset,
	suggestFor,
	uploadAsset,
	withoutAsset,
	type UploadOutcome,
} from "./assets";
import { ASSET_FLOW, EMPTY_FLOW, fileOf, pickFile, releasePick, type AssetFlow, type Note, type Pick } from "./picks";

const OFFLINE_NOTE: Note = {
	message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
	reference: "EF-OFFLINE",
	conflict: true,
};

/**
 * The state and actions of the "Logos and images" group. Picks and notes live in the settings store, so they survive
 * switching sections and mark Brand kit unsaved. An upload or removal updates the kit from its own reply; nothing
 * refreshes the route.
 */
export function useAssets({
	port,
	kit,
	setKit,
	reload,
}: {
	port: BrandPort;
	kit: BrandKit;
	setKit: (kit: BrandKit) => void;
	reload: () => void;
}) {
	const [flow, setFlow] = useFlowState<AssetFlow>(ASSET_FLOW, EMPTY_FLOW);
	const [suggestion, setSuggestion] = useState<SuggestedColors | null>(null);
	// The revision and kit an async step reads when it starts its last call, never the one a render closed over.
	const latest = useRef({ kit, flow });
	useEffect(() => {
		latest.current = { kit, flow };
	});
	// Each upload and removal changes the kit's revision, so they run one after another: the next reads the revision the
	// last one returned, and two slots filled in quick succession never conflict with each other.
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const inOrder = (job: () => Promise<UploadOutcome>): Promise<UploadOutcome> => {
		// The kit a job returns is the latest at once: the next job must not wait for React to render it.
		const run = async () => {
			const outcome = await job();
			if (outcome.ok) latest.current.kit = outcome.kit;
			return outcome;
		};
		const next = queue.current.then(run, run);
		queue.current = next;
		return next;
	};

	const patch = useCallback(
		(slot: AssetSlot, change: { pick?: Pick | null; note?: Note | null }) =>
			setFlow((prev) => {
				const picks = { ...prev.picks };
				const notes = { ...prev.notes };
				if (change.pick !== undefined) {
					releaseIfReplaced(picks[slot], change.pick);
					if (change.pick) picks[slot] = change.pick;
					else delete picks[slot];
				}
				if (change.note !== undefined) {
					if (change.note) notes[slot] = change.note;
					else delete notes[slot];
				}
				return { picks, notes };
			}),
		[setFlow],
	);

	const choose = (slot: AssetSlot, file: File) => {
		const problem = fileProblem(file);
		if (problem) return patch(slot, { note: { message: problem } });
		patch(slot, { pick: { ...pickFile(file), alt: latest.current.flow.picks[slot]?.alt ?? "" }, note: null });
	};

	const setAlt = (slot: AssetSlot, alt: string) => {
		const pick = latest.current.flow.picks[slot];
		if (pick) patch(slot, { pick: { ...pick, alt, altError: undefined } });
	};

	const cancel = (slot: AssetSlot) => patch(slot, { pick: null, note: null });

	const finish = (slot: AssetSlot, pick: Pick, outcome: UploadOutcome) => {
		if (outcome.ok) {
			setKit(outcome.kit);
			patch(slot, { pick: null, note: null });
			if (canSuggest(slot)) void suggest(slot);
			return;
		}
		const { error } = outcome;
		const idle = { ...pick, status: "ready" as const };
		if (!error) return patch(slot, { pick: idle, note: OFFLINE_NOTE });
		if (error.code === "alt_text_required")
			return patch(slot, { pick: { ...idle, altError: ALT_REQUIRED }, note: null });
		const note: Note = { message: assetMessage(error), reference: errorReference(error) };
		// A conflict keeps the file and the text so Load latest and a second Upload finish the job.
		if (error.code === "conflict") return patch(slot, { pick: idle, note: { ...note, conflict: true } });
		patch(slot, { pick: null, note });
	};

	const confirm = async (slot: AssetSlot) => {
		const pick = latest.current.flow.picks[slot];
		const file = pick && fileOf(pick);
		if (!pick || !file || pick.status === "uploading") return;
		if (altProblem(pick.alt)) return patch(slot, { pick: { ...pick, altError: ALT_REQUIRED } });
		const sending = { ...pick, altError: undefined, status: "uploading" as const };
		patch(slot, { pick: sending, note: null });
		const outcome = await inOrder(() =>
			uploadAsset(port, { slot, file, altText: pick.alt.trim(), revision: () => latest.current.kit.revision }),
		);
		finish(slot, sending, outcome);
	};

	const remove = async (slot: AssetSlot) => {
		const before = latest.current.kit;
		setKit(withoutAsset(before, slot));
		patch(slot, { note: null });
		const outcome = await inOrder(() => removeAsset(port, slot, latest.current.kit.revision));
		if (outcome.ok) return setKit(outcome.kit);
		setKit(before);
		patch(slot, {
			note: outcome.error
				? {
						message: assetMessage(outcome.error),
						reference: errorReference(outcome.error),
						conflict: outcome.error.code === "conflict",
					}
				: OFFLINE_NOTE,
		});
	};

	const suggest = async (slot: AssetSlot) => {
		const found = await suggestFor(port, slot);
		if (found) setSuggestion(found);
		else patch(slot, { note: { message: "Colors could not be suggested from this image." } });
	};

	return {
		picks: flow.picks,
		notes: flow.notes,
		suggestion,
		dismissSuggestion: () => setSuggestion(null),
		choose,
		setAlt,
		cancel,
		confirm,
		remove,
		suggest,
		loadLatest: reload,
	};
}

function releaseIfReplaced(old: Pick | undefined, next: Pick | null) {
	if (old && old.url !== next?.url) releasePick(old);
}
