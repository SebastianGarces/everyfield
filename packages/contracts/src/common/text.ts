export const countWord = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export const counted = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${countWord(n, one, many)}`;
