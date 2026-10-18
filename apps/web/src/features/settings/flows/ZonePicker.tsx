"use client";

import { Combobox, Field } from "@everyfield/ui/controls";
import { useMemo } from "react";
import { allZones, zoneLabel } from "../time";

/** A searchable list of IANA time zones. Search matches the city, the zone name and the region. */
export function ZonePicker({
	label,
	value,
	onChange,
	hint,
	error,
}: {
	label: string;
	value: string | null;
	onChange: (zone: string) => void;
	hint?: string;
	error?: string;
}) {
	const options = useMemo(
		() => allZones().map((zone) => ({ value: zone, label: zoneLabel(zone), description: zone })),
		[],
	);
	return (
		<Field label={label} hint={hint} error={error}>
			<Combobox
				options={options}
				value={value ? [value] : []}
				onValueChange={(next) => next[0] && onChange(next[0])}
				searchLabel="Search time zones"
				placeholder="Choose a time zone"
				invalid={Boolean(error)}
			/>
		</Field>
	);
}
