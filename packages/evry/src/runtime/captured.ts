export function captured(match: RegExpExecArray | RegExpMatchArray, group: number): string {
	const value = match[group];
	if (value === undefined) throw new Error(`The pattern matched without capture group ${group}`);
	return value;
}
