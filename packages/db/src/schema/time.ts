// Pin stored spelling to Node 24 ICU canonical names. Historical instants are never recomputed.
export function canonicalTimeZone(input: string): string {
	if (/^[+-]/.test(input)) throw new RangeError("Named time zone required");
	const zone = new Intl.DateTimeFormat("en", { timeZone: input }).resolvedOptions().timeZone;
	if (zone !== "UTC" && !Intl.supportedValuesOf("timeZone").includes(zone))
		throw new RangeError("Named time zone required");
	return zone;
}
