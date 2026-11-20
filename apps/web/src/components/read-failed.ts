import { ServerStack01Icon } from "@hugeicons/core-free-icons";

export const READ_FAILED =
	"Everyfield ran into a problem loading this. Your connection is fine. Try again in a moment.";

export const READ_FAILED_ICON = ServerStack01Icon;

export const loadProblem = (read: { readonly status: string } | null | undefined, otherwise: string) =>
	read?.status === "failed" ? READ_FAILED : otherwise;

export const failedIcon = (read: { readonly status: string } | null | undefined) =>
	read?.status === "failed" ? READ_FAILED_ICON : undefined;

export class FailedRead extends Error {
	constructor(what: string) {
		super(`${what} read failed`);
		this.name = "FailedRead";
	}
}

export const thrownRead = (error: unknown) =>
	error instanceof FailedRead ? ({ status: "failed" } as const) : ({ status: "lost" } as const);
