const { AsyncLocalStorage } = require("node:async_hooks");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const output = process.env.EVF_WRITE_COUNTS;
if (!output) throw Error("observer.cjs needs EVF_WRITE_COUNTS");
const root = join(__dirname, "../../..");
const requests = new AsyncLocalStorage();
const { captureResult, statementStep } = require("./kinds.cjs");
const proc = require("node:crypto").randomUUID().slice(0, 8);
let issued = 0;

const pg = require(require.resolve("pg", { paths: [join(root, "packages/db")] }));
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
	const row = requests.getStore();
	if (!row) return Reflect.apply(query, this, [config, ...rest]);
	const text = typeof config === "string" ? config : (config?.text ?? "");
	const step = statementStep(text, (typeof config === "string" ? undefined : config?.values) ?? rest[0], row.last);
	row.count++;
	row.kinds[step.kind] = (row.kinds[step.kind] ?? 0) + 1;
	if (step.kind === "write") row.writes++;
	row.steps.push({ id: proc + ":" + issued++, ...step });
	row.last = undefined;
	return captureResult(
		[config, ...rest],
		(args) => Reflect.apply(query, this, args),
		(seen) => {
			row.last = seen;
		},
	);
};
const connect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
	const row = requests.getStore();
	if (row) row.connects++;
	return Reflect.apply(connect, this, args);
};

const createServer = http.createServer;
http.createServer = function (...args) {
	const at = args.findIndex((arg) => typeof arg === "function");
	if (at >= 0) {
		const handle = args[at];
		args[at] = function (request, response) {
			const name = request.headers["x-evf-request"];
			if (typeof name !== "string") return handle.call(this, request, response);
			const row = { kind: "sample", name, count: 0, writes: 0, rollbacks: 0, connects: 0, kinds: {}, steps: [] };
			response.once("finish", () => {
				const { last, steps, ...counts } = row;
				const sample = { ...counts, kinds: { ...row.kinds }, status: response.statusCode };
				appendFileSync(output, JSON.stringify(row.writes > 0 ? { ...sample, steps } : sample) + "\n");
			});
			return requests.run(row, () => handle.call(this, request, response));
		};
	}
	return Reflect.apply(createServer, this, args);
};
