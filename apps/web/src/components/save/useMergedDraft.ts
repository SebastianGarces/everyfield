import { useState } from "react";
import { mergeDraft, pickField, pickTyped, type ConflictField, type Pick, type Picks } from "./conflict.ts";

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
