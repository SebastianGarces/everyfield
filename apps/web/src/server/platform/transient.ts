import { isTransient, logFailure, type LogFields } from "@everyfield/domain/log";
import { ServerConfigError } from "../config.ts";

type Fields = Record<string, string | number | boolean | null>;

export const LOST = { status: "lost" } as const;

export class ServerFailure extends Error {
	constructor() {
		super("server_failure");
		this.name = "ServerFailure";
	}
}

const nextSignal = (error: unknown) =>
	typeof error === "object" && error !== null && typeof (error as { digest?: unknown }).digest === "string";

export function unexpected<const F extends Fields>(fields: LogFields<F>, error: unknown): Error {
	if (error instanceof ServerConfigError || error instanceof ServerFailure || nextSignal(error)) return error as Error;
	logFailure(fields, error);
	return new ServerFailure();
}

export async function transient<const F extends Fields, T, L>(
	fields: LogFields<F>,
	body: () => Promise<T>,
	lost: L,
): Promise<T | L> {
	try {
		return await body();
	} catch (error) {
		if (!isTransient(error)) throw unexpected(fields, error);
		logFailure(fields, error);
		return lost;
	}
}
