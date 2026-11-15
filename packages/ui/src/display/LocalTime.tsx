"use client";

import { useBrowserZone } from "../foundations";

export type LocalTimeStyle = "date" | "dateTime";

const DATE = { month: "short", day: "numeric", year: "numeric" } as const;
const DATE_TIME = { ...DATE, hour: "numeric", minute: "2-digit" } as const;

export function formatLocalTime(iso: string, zone: string, style: LocalTimeStyle = "dateTime"): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { ...(style === "dateTime" ? DATE_TIME : DATE), timeZone: zone })
			.formatToParts(new Date(iso))
			.map((p) => [p.type, p.value]),
	);
	const date = `${parts.month} ${parts.day}, ${parts.year}`;
	return style === "dateTime" ? `${date}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}` : date;
}

export function useLocalTime(iso: string, style: LocalTimeStyle = "dateTime"): string {
	return formatLocalTime(iso, useBrowserZone() ?? "UTC", style);
}

export function LocalTime({
	iso,
	style = "dateTime",
	className,
}: {
	iso: string;
	style?: LocalTimeStyle;
	className?: string;
}) {
	const text = useLocalTime(iso, style);
	return (
		<time dateTime={iso} className={className}>
			{text}
		</time>
	);
}
