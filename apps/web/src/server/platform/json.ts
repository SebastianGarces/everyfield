export function parseJson(text: string | Uint8Array): unknown {
	try {
		return JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text));
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}
