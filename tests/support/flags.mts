import { registry, setFlag } from "../../packages/domain/src/flags/index.ts";

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

export async function withSwitchOff(db, { flag, operator }, body) {
	if (registry[flag]?.kind !== "kill") throw Error(`withSwitchOff turns off kill switches only, not ${flag}`);
	await setFlag(db, { flag, scope: { kind: "global" }, value: false, operator });
	try {
		return await body();
	} finally {
		await setFlag(db, { flag, scope: { kind: "global" }, value: null, operator });
	}
}

export function capturedLines(body) {
	const lines = [];
	const write = console.error;
	console.error = (line, ...rest) => {
		if (typeof line === "string" && line.startsWith("{")) lines.push(JSON.parse(line));
		else write(line, ...rest);
	};
	return Promise.resolve()
		.then(body)
		.then(
			(value) => ({ value, lines }),
			(error) => ({ error, lines }),
		)
		.finally(() => {
			console.error = write;
		});
}
