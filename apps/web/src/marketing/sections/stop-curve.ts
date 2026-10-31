export type Pt = { x: number; y: number };

/**
 * The dotted path of a photo band (the OPS-82 prototype's pthLayout): one smooth curve with horizontal tangents through
 * the stop centres. It enters 20 px left of the band, 18 px under the first stop, and leaves 20 px right of it, 18 px
 * over the last stop. Returns the path commands: the move, then one curve per point, so `slice(0, i + 2)` ends at stop i.
 */
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

/** The stops sit at the centres of n equal columns across the band. */
export const stopLeft = (i: number, n: number) => `${((100 / n) * (i + 0.5)).toFixed(3)}%`;
