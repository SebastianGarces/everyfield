const { AsyncLocalStorage } = require("node:async_hooks");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const output = process.env.EVF_WRITE_COUNTS;
if (!output) throw Error("observer.cjs needs EVF_WRITE_COUNTS");
const root = join(__dirname, "../../..");
const requests = new AsyncLocalStorage();
const { repeatedShapes, statementKind, statementShape } = require("./kinds.cjs");

const pg = require(require.resolve("pg", { paths: [join(root, "packages/db")] }));
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
	const row = requests.getStore();
	if (row) {
		const text = typeof config === "string" ? config : (config?.text ?? "");
		const kind = statementKind(text);
		const shape = kind === "transaction" ? null : statementShape(text);
		if (shape) row.shapes.set(shape, (row.shapes.get(shape) ?? 0) + 1);
		row.count++;
		row.kinds[kind] = (row.kinds[kind] ?? 0) + 1;
		if (kind === "write") row.writes++;
	}
	return Reflect.apply(query, this, [config, ...rest]);
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
			const row = {
				kind: "sample",
				name,
				count: 0,
				writes: 0,
				rollbacks: 0,
				connects: 0,
				kinds: {},
				shapes: new Map(),
			};
			response.once("finish", () => {
				const { shapes, ...counts } = row;
				const repeats = repeatedShapes(shapes);
				const sample = { ...counts, kinds: { ...row.kinds }, status: response.statusCode };
				appendFileSync(output, JSON.stringify(Object.keys(repeats).length ? { ...sample, repeats } : sample) + "\n");
			});
			return requests.run(row, () => handle.call(this, request, response));
		};
	}
	return Reflect.apply(createServer, this, args);
};
