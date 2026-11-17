import type { adultClassification, adultClassificationSource } from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import type { z } from "zod";

const ADULT_AGE = 18;

type ManualClassification = z.infer<typeof adultClassification>;
type AdultSource = z.infer<typeof adultClassificationSource>;

function fullAge(birthDate: string, today: string): number {
	const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
	const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
	return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export function effectiveAdult(
	birthDate: string | null,
	manual: ManualClassification,
	today: string | null,
): { value: ManualClassification; source: AdultSource } {
	if (birthDate === null) return { value: manual, source: manual === "unknown" ? "not_recorded" : "recorded" };
	if (today === null) throw new Error("A person with a birth date needs the plant-local date");
	return { value: fullAge(birthDate, today) >= ADULT_AGE ? "adult" : "child", source: "birth_date" };
}

export const plantTodaySql = (plantId: SQL) =>
	sql`(SELECT (clock_timestamp() AT TIME ZONE pl.timezone)::date::text FROM plant pl WHERE pl.id=${plantId})`;

export const effectiveAdultSql = (birth: SQL, manual: SQL, today: SQL) =>
	sql`(CASE WHEN ${birth} IS NULL THEN ${manual}
 WHEN (EXTRACT(YEAR FROM ${today}::date)-EXTRACT(YEAR FROM ${birth}::date)-CASE WHEN (EXTRACT(MONTH FROM ${today}::date),EXTRACT(DAY FROM ${today}::date))<(EXTRACT(MONTH FROM ${birth}::date),EXTRACT(DAY FROM ${birth}::date)) THEN 1 ELSE 0 END)>=${ADULT_AGE} THEN 'adult'
 ELSE 'child' END)`;
