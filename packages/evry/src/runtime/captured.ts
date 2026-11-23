export function captured(match: RegExpExecArray | RegExpMatchArray, group: number): string {
	const value = match[group];
	if (value === undefined) throw new Error(`The pattern matched without capture group ${group}`);
	return value;
}

export function present<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("An expected value is missing");
	return value;
}
