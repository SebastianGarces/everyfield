export type Pt = { x: number; y: number };

export function stopCurve(stops: Pt[], width: number): string[] {
	const first = stops[0],
		last = stops.at(-1);
	if (!first || !last) return [];
	const start = { x: -20, y: first.y + 18 };
	const d = [`M${start.x},${start.y}`];
	let a = start;
	for (const z of [...stops, { x: width + 20, y: last.y - 18 }]) {
		const m = (z.x - a.x) / 2;
		d.push(` C${a.x + m},${a.y} ${z.x - m},${z.y} ${z.x},${z.y}`);
		a = z;
	}
	return d;
}

export const stopLeft = (i: number, n: number) => `${((100 / n) * (i + 0.5)).toFixed(3)}%`;
