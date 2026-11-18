export const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};
