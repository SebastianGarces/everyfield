import { setFlag, type FlagScope, type Registry } from "../../packages/domain/src/flags/index.ts";

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
