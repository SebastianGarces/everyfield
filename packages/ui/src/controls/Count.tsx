"use client";

import NumberFlow, { type Format } from "@number-flow/react";

const PLAIN: Format = { useGrouping: false };

export function Count({ value }: { value: number }) {
	return (
		<span className="relative inline-flex tabular-nums">
			<span className="sr-only">{value}</span>
			<NumberFlow aria-hidden="true" value={value} format={PLAIN} />
		</span>
	);
}
