export type DayTextOptions = {
	year?: "never" | number;
	weekday?: "short" | "long";
	month?: "short" | "long";
	locale?: "viewer";
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function noon(day: string): Date {
	const parts = DAY.exec(day);
	const at = parts && new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12));
	if (!at || at.toISOString().slice(0, 10) !== day) throw new RangeError(`Not a civil day: ${day}`);
	return at;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(options: DayTextOptions, year: boolean) {
	const { weekday, month = "short", locale } = options;
	const key = `${weekday ?? ""}/${month}/${year}/${locale}`;
	const known = formats.get(key);
	if (known) return known;
	const made = new Intl.DateTimeFormat(locale === "viewer" ? undefined : "en-US", {
		timeZone: "UTC",
		...(weekday ? { weekday } : {}),
		month,
		day: "numeric",
		...(year ? { year: "numeric" } : {}),
	});
	formats.set(key, made);
	return made;
}

export function dayText(day: string, options: DayTextOptions = {}): string {
	const at = noon(day);
	const year = options.year === undefined || (options.year !== "never" && at.getUTCFullYear() !== options.year);
	return format(options, year).format(at);
}

export const addDays = (day: string, n: number): string =>
	new Date(noon(day).getTime() + n * MS_PER_DAY).toISOString().slice(0, 10);

export const weekdayOf = (day: string): number => noon(day).getUTCDay();

export const daysBetween = (from: string, to: string): number =>
	(noon(to).getTime() - noon(from).getTime()) / MS_PER_DAY;
