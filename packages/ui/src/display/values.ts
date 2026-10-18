/**
 * A recorded count, or null when nothing was recorded. The two never mix: null is shown as "Not recorded" and 0 as
 * 0 (foundations.md and the Outcome field row: an empty count is not a zero).
 */
export type Count = number | null;

const COUNT = new Intl.NumberFormat("en-US");

/** 1234 is "1,234". */
export function formatCount(value: number): string {
	return COUNT.format(value);
}

/**
 * Data a component loads, in one of three states. Each state carries only what it can show, so a component cannot
 * draw rows while it also reports an error. An empty `data` is the ready state's empty case.
 */
export type Loadable<T> =
	| { status: "loading" }
	| {
			status: "error";
			/** What failed, in words: "People did not load." */
			title?: string;
			onRetry?: () => void;
			/** "Last loaded today at 8:40 am · Error reference EF-7Q2K". */
			meta?: string;
	  }
	| { status: "ready"; data: T };
