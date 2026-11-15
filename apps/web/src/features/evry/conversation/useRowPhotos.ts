"use client";

import { useMemo, useState } from "react";
import { createRead, useRead } from "@/components/read";
import type { Turn } from "./model.ts";
import { readRowPhotos } from "./photoActions.ts";
import { cardView } from "./resultView.ts";

const BATCH = 100;
const NONE: Readonly<Record<string, string>> = {};

const batches = (ids: readonly string[]) =>
	Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, i) => ids.slice(i * BATCH, (i + 1) * BATCH));

const rowPhotos = createRead(
	(personIds: string[]) =>
		Promise.all(batches(personIds).map((batch) => readRowPhotos(batch))).then((found) => Object.assign({}, ...found)),
	{ failed: () => NONE },
);

const photoIds = (turns: readonly Turn[]) =>
	[
		...new Set(
			turns.flatMap((t) =>
				t.blocks.flatMap((b) =>
					b.kind === "result"
						? cardView(b.operation, b.result, b.originalTotal).rows.flatMap((r) => (r.photoFor ? [r.photoFor] : []))
						: [],
				),
			),
		),
	].sort();

export function useRowPhotos(turns: readonly Turn[]): Readonly<Record<string, string>> {
	const ids = useMemo(() => photoIds(turns), [turns]);
	const value = useRead(ids.length ? rowPhotos : null, ids).value;
	const [shown, setShown] = useState(NONE);
	if (value && value !== shown) setShown(value);
	return value ?? shown;
}
