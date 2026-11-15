"use client";

import { createRead, useRead } from "@/components/read";
import { readRowPhotos } from "./photoActions.ts";

const NONE: Readonly<Record<string, string>> = {};

const rowPhotos = createRead((personIds: string[]) => readRowPhotos(personIds), { failed: () => NONE });

export function useRowPhotos(personIds: readonly string[]): Readonly<Record<string, string>> {
	const ids = [...new Set(personIds)].sort();
	return useRead(ids.length ? rowPhotos : null, ids).value ?? NONE;
}
