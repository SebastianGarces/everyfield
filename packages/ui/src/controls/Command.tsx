"use client";

export { Command } from "cmdk";

const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"]);

export function keepKeyInField(event: { key: string; stopPropagation: () => void }) {
	if (LIST_KEYS.has(event.key)) event.stopPropagation();
}
