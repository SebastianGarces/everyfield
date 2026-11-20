export type Count = number | null;

const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
	return COUNT.format(value);
}

export type Loadable<T> =
	| { status: "loading" }
	| {
			status: "error";
			title?: string;
			text?: string;
			onRetry?: () => void;
			meta?: string;
	  }
	| { status: "ready"; data: T };
