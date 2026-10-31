import { sql, type SQL } from "@everyfield/db/query";

/** Full age in years from which a person with a birth date is an adult. */
export const ADULT_AGE = 18;

export type ManualClassification = "adult" | "child" | "unknown";
export type AdultSource = "birth_date" | "recorded" | "not_recorded";

/**
 * Full age in years on `today`: the year difference, minus one while (month, day) of today is before the birth
 * (month, day). A Feb 29 birth therefore has its birthday on Mar 1 in a year without a Feb 29. Both are `YYYY-MM-DD`.
 */
export function fullAge(birthDate: string, today: string): number {
	const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
	const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
	return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/**
 * The adult or child value a person has: derived from the birth date when there is one (REQ-PPL-026), else the
 * manual value. `today` is the plant-local current date. Nothing stores the derived value.
 */
export function effectiveAdult(
	birthDate: string | null,
	manual: ManualClassification,
	today: string | null,
): { value: ManualClassification; source: AdultSource } {
	if (birthDate === null) return { value: manual, source: manual === "unknown" ? "not_recorded" : "recorded" };
	if (today === null) throw new Error("A person with a birth date needs the plant-local date");
	return { value: fullAge(birthDate, today) >= ADULT_AGE ? "adult" : "child", source: "birth_date" };
}

/** The calendar date at instant `at` in time zone `zone` (a plant's `timezone`). */
export const localDateSql = (at: SQL, zone: SQL) => sql`((${at}) AT TIME ZONE ${zone})::date`;

/** The plant-local current date of a plant, as one scalar subquery: `plantId` names the plant's ID. */
export const plantTodaySql = (plantId: SQL) =>
	sql`(SELECT ${localDateSql(sql`clock_timestamp()`, sql`pl.timezone`)}::text FROM plant pl WHERE pl.id=${plantId})`;

/**
 * `effectiveAdult` in SQL, from the same rule. `birth` is a date, `manual` the stored text and `today` a date
 * expression. A test runs both over the same cases.
 */
export const effectiveAdultSql = (birth: SQL, manual: SQL, today: SQL) =>
	sql`(CASE WHEN ${birth} IS NULL THEN ${manual}
 WHEN (EXTRACT(YEAR FROM ${today}::date)-EXTRACT(YEAR FROM ${birth}::date)-CASE WHEN (EXTRACT(MONTH FROM ${today}::date),EXTRACT(DAY FROM ${today}::date))<(EXTRACT(MONTH FROM ${birth}::date),EXTRACT(DAY FROM ${birth}::date)) THEN 1 ELSE 0 END)>=${ADULT_AGE} THEN 'adult'
 ELSE 'child' END)`;
