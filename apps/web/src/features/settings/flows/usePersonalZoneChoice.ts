"use client";

import { useState } from "react";
import type { FlowPort, PersonalTimezonePreview, PersonalTimezoneResult } from "../port";
import { OFFLINE_REFERENCE, useWrite, type Outcome } from "../save";
import { zoneLabel } from "../time";

export function usePersonalZoneChoice(
	calls: Pick<FlowPort, "previewPersonalTimezone" | "setPersonalTimezone">,
	skip: string | null = null,
) {
	const [zone, setZone] = useState<string | null>(null);
	const [preview, setPreview] = useState<PersonalTimezonePreview | null>(null);
	const previewing = useWrite("personal-timezone-preview");
	const saving = useWrite("personal-timezone");

	const choose = async (next: string) => {
		setZone(next);
		setPreview(null);
		saving.setRefusal(null);
		if (next === skip) return;
		const result = await previewing.run({ next, at: Date.now() }, () =>
			calls.previewPersonalTimezone({ timeZone: next }),
		);
		if (result.ok) setPreview(result.value);
	};

	const save = async (): Promise<Outcome<PersonalTimezoneResult> | null> => {
		if (!preview) return null;
		const input = { timeZone: preview.newZone, previewId: preview.previewId, confirmed: true as const };
		const send = () =>
			saving.run(input, (requestKey) =>
				calls.setPersonalTimezone({ requestKey, expectedRevision: preview.expectedRevision, input }),
			);
		let result = await send();
		if (!result.ok && result.refusal.reference === OFFLINE_REFERENCE) result = await send();
		return result;
	};

	const stale = saving.refusal?.code === "stale_preview" || saving.refusal?.code === "conflict";
	const city = zone ? zoneLabel(zone).split(" · ")[0] : "";

	return { zone, preview, previewing, saving, choose, save, stale, city };
}
