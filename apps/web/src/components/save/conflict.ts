import { useState } from "react";

export type Pick = "saved" | "mine";
export type Picks = Readonly<Record<string, { pick: Pick; saved: unknown }>>;
export type ConflictField<T> = { key: keyof T & string; label: string; text: (value: T) => string };
export type ConflictRow = { field: string; label: string; saved: string; mine: string; pick: Pick | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergeDraft<T extends object>({
	base,
	mine,
	latest,
	picks,
	fields,
}: {
	base: T;
	mine: T;
	latest: T;
	picks: Picks;
	fields: readonly ConflictField<T>[];
}): { values: T; rows: ConflictRow[]; unchosen: boolean } {
	const values = { ...latest };
	for (const key of Object.keys(mine) as (keyof T)[]) if (!same(mine[key], base[key])) values[key] = mine[key];
	const rows: ConflictRow[] = [];
	for (const { key, label, text } of fields) {
		if (same(latest[key], base[key]) || same(latest[key], mine[key])) continue;
		const chosen = picks[key];
		const pick =
			chosen && same(chosen.saved, latest[key]) ? chosen.pick : same(mine[key], base[key]) ? ("saved" as const) : null;
		values[key] = pick === "saved" ? latest[key] : mine[key];
		rows.push({ field: key, label, saved: text(latest), mine: text(mine), pick });
	}
	return { values, rows, unchosen: rows.some((row) => row.pick === null) };
}

export function pickField<T extends object>(picks: Picks, latest: T, key: string, pick: Pick): Picks {
	return { ...picks, [key]: { pick, saved: latest[key as keyof T] } };
}

export function pickTyped<T extends object>(picks: Picks, latest: T, patch: Partial<T>): Picks {
	return Object.keys(patch).reduce((all, key) => pickField(all, latest, key, "mine"), picks);
}

export function useMergedDraft<T extends object>(options: {
	base: T;
	latest: T;
	start?: T;
	fields: readonly ConflictField<T>[];
}) {
	const { latest, fields } = options;
	const [state, setState] = useState(() => ({
		base: options.base,
		mine: options.start ?? options.base,
		picks: {} as Picks,
	}));
	return {
		...mergeDraft({ ...state, latest, fields }),
		set: (patch: Partial<T>) =>
			setState((s) => ({ ...s, mine: { ...s.mine, ...patch }, picks: pickTyped(s.picks, latest, patch) })),
		choose: (key: string, pick: Pick) => setState((s) => ({ ...s, picks: pickField(s.picks, latest, key, pick) })),
	};
}

export const changesKept = (what: string) =>
	`Someone else saved ${what} while you were editing. Your changes are kept. Check them, then save again.`;
export const CHOOSE_FIRST = "Choose a version for each field below, then save again.";
