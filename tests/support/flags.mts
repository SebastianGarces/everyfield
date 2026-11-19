import { setFlag } from "../../packages/domain/src/flags/index.ts";

export async function withFlag(db, { flag, scope, operator, value = true, declared = undefined }, body) {
	if (scope.kind !== "workspace" && scope.kind !== "account")
		throw Error("withFlag sets a flag for one workspace or account, never globally");
	await setFlag(db, { flag, scope, value, operator }, declared);
	try {
		return await body();
	} finally {
		await setFlag(db, { flag, scope, value: null, operator }, declared);
	}
}
