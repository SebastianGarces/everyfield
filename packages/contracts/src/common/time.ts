import { z } from "zod";

export const localDate = z.iso.date().brand<"LocalDate">();
export const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  .refine(v => localDate.safeParse(v.slice(0, 10)).success &&
    Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60 && Number(v.slice(17, 19)) < 60)
  .brand<"LocalDateTime">();
export const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .refine(v => localDateTime.safeParse(v.slice(0, 19)).success)
  .transform(v => new Date(v).toISOString()).brand<"Instant">();
export const timeZone = z.string().min(1).max(100).refine(v => {
  // Reject numeric offsets. Calendar context requires a named IANA zone.
  if (/^[+-]/.test(v)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; }
}).brand<"TimeZone">();
export type LocalDate = z.infer<typeof localDate>;
export type LocalDateTime = z.infer<typeof localDateTime>;
export type Instant = z.infer<typeof instant>;
export type TimeZone = z.infer<typeof timeZone>;
export interface Clock { now(): Instant }
export function frozenClock(asOf: Instant): Clock { return { now: () => asOf }; }

function formatter(zone: TimeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function wallAt(ms: number, zone: TimeZone): LocalDateTime {
  const parts = formatter(zone).formatToParts(ms);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)?.value;
  return localDateTime.parse(`${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`);
}
const wallMs = (wall: LocalDateTime) => Date.parse(`${wall}Z`);
export type Occurrence = Readonly<{ instant: Instant; offsetSeconds: number }>;
export type Resolution =
  | { kind: "resolved"; entered: LocalDateTime; zone: TimeZone; occurrence: Occurrence; resolverVersion: 1; adjustmentSeconds: number }
  | { kind: "gap"; entered: LocalDateTime; zone: TimeZone }
  | { kind: "fold"; entered: LocalDateTime; zone: TimeZone; choices: readonly Occurrence[] }
  | { kind: "invalid_offset"; entered: LocalDateTime; zone: TimeZone };

// Resolver v1: earlier fold; forward by the actual gap, including non-hour gaps.
// IANA offsets are sampled around the requested wall time, never from the host zone.
export function resolveCalendar(wall: LocalDateTime, zone: TimeZone,
  mode: "entered" | "automatic", selectedOffsetSeconds?: number): Resolution {
  const naive = wallMs(wall);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = naive + hours * 3_600_000;
    offsets.add((wallMs(wallAt(probe, zone)) - probe) / 1000);
  }
  const candidates = [...offsets].map(offsetSeconds => ({
    instant: instant.parse(new Date(naive - offsetSeconds * 1000).toISOString()), offsetSeconds,
  })).sort((a, b) => a.instant.localeCompare(b.instant));
  const choices = candidates.filter(c => wallAt(Date.parse(c.instant), zone) === wall);
  const selected = choices.find(c => c.offsetSeconds === selectedOffsetSeconds);
  if (selectedOffsetSeconds !== undefined && !selected) return { kind: "invalid_offset", entered: wall, zone };
  if (choices.length === 0) {
    if (mode === "entered") return { kind: "gap", entered: wall, zone };
    const shifted = candidates.map(c => ({ c, shift: (wallMs(wallAt(Date.parse(c.instant), zone)) - naive) / 1000 }))
      .filter(c => c.shift > 0).sort((a, b) => a.shift - b.shift)[0];
    if (!shifted) throw new RangeError("Calendar time cannot be resolved");
    const at = Date.parse(shifted.c.instant);
    const occurrence = { instant: shifted.c.instant, offsetSeconds: (wallMs(wallAt(at, zone)) - at) / 1000 };
    return { kind: "resolved", entered: wall, zone, occurrence, resolverVersion: 1, adjustmentSeconds: shifted.shift };
  }
  if (choices.length > 1 && mode === "entered" && !selected) return { kind: "fold", entered: wall, zone, choices };
  const occurrence = selected ?? choices[0];
  if (!occurrence) throw new RangeError("Calendar time cannot be resolved");
  return { kind: "resolved", entered: wall, zone, occurrence, resolverVersion: 1, adjustmentSeconds: 0 };
}
export function addCivilDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) throw new RangeError("Civil days must be integral");
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return localDate.parse(value.toISOString().slice(0, 10));
}
export function localDayBounds(date: LocalDate, zone: TimeZone): { start: Instant; end: Instant } {
  const midnight = (day: LocalDate) => {
    const result = resolveCalendar(localDateTime.parse(`${day}T00:00:00`), zone, "automatic");
    if (result.kind !== "resolved") throw new RangeError("Local day cannot be resolved");
    return result.occurrence.instant;
  };
  return { start: midnight(date), end: midnight(addCivilDays(date, 1)) };
}
export function calendarContext(zone: TimeZone, clock: Clock) {
  const asOf = clock.now();
  return { asOf, zone, localDate: localDate.parse(wallAt(Date.parse(asOf), zone).slice(0, 10)), resolverVersion: 1 as const };
}

// Persist entered wall time, confirmed zone/offset and resolved instant together.
// Reads preserve the saved instant even after preferences or IANA rules change.
// Resolve/validate the entered choice at creation, not while hydrating history.
export const resolvedTime = z.strictObject({
  entered: localDateTime, zone: timeZone,
  occurrence: z.strictObject({ instant, offsetSeconds: z.number().int().min(-86400).max(86400) }),
  resolverVersion: z.literal(1), adjustmentSeconds: z.number().int().nonnegative().max(86400),
}).refine(value => Date.parse(value.occurrence.instant) + value.occurrence.offsetSeconds * 1000 ===
  wallMs(value.entered) + value.adjustmentSeconds * 1000, { message: "inconsistent_resolved_time" });
