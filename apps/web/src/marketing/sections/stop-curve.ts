export type Pt = { x: number; y: number };

export function stopCurve(stops: Pt[], width: number): string[] {
	const first = stops[0]!,
		last = stops[stops.length - 1]!;
	const pts: Pt[] = [{ x: -20, y: first.y + 18 }, ...stops, { x: width + 20, y: last.y - 18 }];
	const d = [`M${pts[0]!.x},${pts[0]!.y}`];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!,
			z = pts[i]!,
			m = (z.x - a.x) / 2;
		d.push(` C${a.x + m},${a.y} ${z.x - m},${z.y} ${z.x},${z.y}`);
	}
	return d;
}

export const stopLeft = (i: number, n: number) => `${((100 / n) * (i + 0.5)).toFixed(3)}%`;
