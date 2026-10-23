// Preloaded into `next start` by requests.mjs (NODE_OPTIONS=--require). Counts every SQL statement each HTTP request
// sends, the session lookup included, and appends one row per request to $EVF_WRITE_COUNTS when its response finishes.
// It records statement kinds only, never SQL text or parameters. A request names itself with the x-evf-request header.
// `connects` counts the database connections a request opens itself; server start opens the ones a request needs.
const { AsyncLocalStorage } = require("node:async_hooks");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const output = process.env.EVF_WRITE_COUNTS;
if (!output) throw Error("observer.cjs needs EVF_WRITE_COUNTS");
const root = join(__dirname, "../../..");
const requests = new AsyncLocalStorage();
const { statementKind } = require("./kinds.cjs");

// The app's pg is the copy @everyfield/db resolves; Next keeps pg external, so it loads this same module.
const pg = require(require.resolve("pg", { paths: [join(root, "packages/db")] }));
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
	const row = requests.getStore();
	if (row) {
		const kind = statementKind(typeof config === "string" ? config : (config?.text ?? ""));
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
			const row = { kind: "sample", name, count: 0, writes: 0, rollbacks: 0, connects: 0, kinds: {} };
			// Statements an after() callback sends once the response is complete are not part of the request's time.
			response.once("finish", () => {
				appendFileSync(output, JSON.stringify({ ...row, kinds: { ...row.kinds }, status: response.statusCode }) + "\n");
			});
			return requests.run(row, () => handle.call(this, request, response));
		};
	}
	return Reflect.apply(createServer, this, args);
};
