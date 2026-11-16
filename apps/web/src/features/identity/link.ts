"use client";

import { useLayoutEffect } from "react";
import { writeAddress } from "../../components/location.ts";

export function useLinkSecretLeavesAddress(take: () => string | null): void {
	useLayoutEffect(() => {
		const clean = take();
		if (clean !== null) writeAddress(clean, { replace: true });
	}, [take]);
}

export function takeQueryProof(): string | null {
	return new URLSearchParams(window.location.search).has("token") ? window.location.pathname : null;
}
