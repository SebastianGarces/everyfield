export type Scores = { at(i: number, j: number): number; set(i: number, j: number, value: number): void };

export function scores(rows: number, columns: number): Scores {
	const width = columns + 1;
	const cells = new Array<number>((rows + 1) * width).fill(0);
	return {
		at: (i, j) => cells[i * width + j] ?? 0,
		set: (i, j, value) => {
			cells[i * width + j] = value;
		},
	};
}

export const backwards = <T>(items: readonly T[]): [number, T][] => [...items.entries()].reverse();

export function pairs<A, B>(left: readonly A[], right: readonly B[]): [A, B][] {
	if (left.length !== right.length) throw Error("unpaired_sides");
	return left.map((item, k) => {
		const other = right[k];
		if (other === undefined) throw Error("unpaired_sides");
		return [item, other];
	});
}
