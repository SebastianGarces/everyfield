"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Turn } from "./model.ts";
import { readRowPhotos } from "./photoActions.ts";
import { cardView } from "./resultView.ts";

/** The most people one read asks for (personPhotosRequest). */
const BATCH = 100;
const NONE: Readonly<Record<string, string>> = {};

/**
 * The photo route of each person row on the conversation's result cards, by person id. Each person is read the first
 * time they show in the open conversation, and opening a conversation reads them all again, so a card shows the photos
 * as they are now. Rows keep the initials until a photo arrives, and for good when there is none.
 */
export function useRowPhotos(conversationId: string | null, turns: readonly Turn[]) {
	const [photos, setPhotos] = useState<{ id: string | null; byPerson: Readonly<Record<string, string>> }>({
		id: conversationId,
		byPerson: NONE,
	});
	const asked = useRef({ id: conversationId, people: new Set<string>() });
	const people = useMemo(
		() =>
			turns.flatMap((t) =>
				t.blocks.flatMap((b) =>
					b.kind === "result"
						? cardView(b.operation, b.result, b.originalTotal).rows.flatMap((r) => (r.person ? [r.person] : []))
						: [],
				),
			),
		[turns],
	);
	useEffect(() => {
		const id = conversationId;
		if (asked.current.id !== id) asked.current = { id, people: new Set() };
		const seen = asked.current.people;
		const missing = [...new Set(people)].filter((p) => !seen.has(p));
		for (const p of missing) seen.add(p);
		for (let i = 0; i < missing.length; i += BATCH)
			void readRowPhotos(missing.slice(i, i + BATCH)).then((found) => {
				if (asked.current.id !== id) return;
				setPhotos((s) => ({ id, byPerson: s.id === id ? { ...s.byPerson, ...found } : found }));
			});
	}, [conversationId, people]);
	return photos.id === conversationId ? photos.byPerson : NONE;
}
