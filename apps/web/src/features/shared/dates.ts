export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(
		new Date(instant),
	);
}

export function offsetText(seconds: number): string {
	const sign = seconds < 0 ? "−" : "+";
	const abs = Math.abs(seconds),
		h = Math.floor(abs / 3600),
		m = Math.round((abs % 3600) / 60);
	return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
