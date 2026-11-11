// The search params Next.js hands a page, as URLSearchParams, so each feature's model can parse its own query.
// Shared by the tasks, people, meetings, documents and notifications routes. Relative imports only, so node tests
// can import it by path.

/** A page's `searchParams` record as URLSearchParams; an array value becomes repeated keys. */
export const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};
