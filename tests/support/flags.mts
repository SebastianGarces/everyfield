import { setFlag, type FlagScope, type KillSwitch, type Registry } from "../../packages/domain/src/flags/index.ts";

type Change<R extends Registry> = Parameters<typeof setFlag<R>>[1];

export async function withFlag<R extends Registry, T>(
	db: Parameters<typeof setFlag<R>>[0],
	{
		flag,
		scope,
		operator,
		value = true,
		declared = undefined,
	}: { flag: Change<R>["flag"]; scope: FlagScope; operator: Change<R>["operator"]; value?: boolean; declared?: R },
	body: () => Promise<T>,
) {
	if (scope.kind !== "workspace" && scope.kind !== "account")
		throw Error("withFlag sets a flag for one workspace or account, never globally");
	await setFlag(db, { flag, scope, value, operator }, declared);
	try {
		return await body();
	} finally {
		await setFlag(db, { flag, scope, value: null, operator }, declared);
	}
}

export async function withSwitchOff<T>(
	db: Parameters<typeof setFlag>[0],
	{ flag, operator }: { flag: KillSwitch; operator: Change<Registry>["operator"] },
	body: () => Promise<T>,
): Promise<T> {
	await setFlag(db, { flag, scope: { kind: "global" }, value: false, operator });
	try {
		return await body();
	} finally {
		await setFlag(db, { flag, scope: { kind: "global" }, value: null, operator });
	}
}

export type LogLine = Record<string, unknown>;

export async function capturedLines<T>(body: () => T | Promise<T>): Promise<{ value: T; lines: LogLine[] }> {
	const lines: LogLine[] = [];
	const write = console.error;
	console.error = (line?: unknown, ...rest: unknown[]) => {
		if (typeof line === "string" && line.startsWith("{")) lines.push(JSON.parse(line) as LogLine);
		else write(line, ...rest);
	};
	try {
		return { value: await body(), lines };
	} finally {
		console.error = write;
	}
}
