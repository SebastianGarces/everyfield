export const READ_FAILED = "Everyfield ran into a problem loading this. Your connection is fine. Try again later.";

export const loadProblem = (read: { readonly status: string } | null | undefined, otherwise: string) =>
	read?.status === "failed" ? READ_FAILED : otherwise;

export class FailedRead extends Error {
	constructor(what: string) {
		super(`${what} read failed`);
		this.name = "FailedRead";
	}
}

export const thrownRead = (error: unknown) =>
	error instanceof FailedRead ? ({ status: "failed" } as const) : ({ status: "lost" } as const);
