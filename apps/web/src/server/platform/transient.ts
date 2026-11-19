import "server-only";
import { isTransient, logFailure, type LogFields } from "@everyfield/domain/log";

export const LOST = { status: "lost" } as const;

export async function transient<const F extends Record<string, string | number | boolean | null>, T, L>(
	fields: LogFields<F>,
	body: () => Promise<T>,
	lost: L,
): Promise<T | L> {
	try {
		return await body();
	} catch (error) {
		if (!isTransient(error)) throw error;
		logFailure(fields, error);
		return lost;
	}
}
