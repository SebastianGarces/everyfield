const net = require("node:net");

const loopback = (host) => /^127\./.test(host) || ["::1", "localhost", "::ffff:127.0.0.1"].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const [first] = args;
	const options = Array.isArray(first)
		? first[0]
		: typeof first === "object" && first !== null
			? first
			: { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
	const host = options.host ?? "localhost";
	if (options.path !== undefined || loopback(host)) return connect.apply(this, args);
	process.stderr.write(`offline guard: blocked a connection to ${host}:${options.port}\n`);
	const error = Object.assign(new Error(`${host}:${options.port} is not loopback`), { code: "ECONNREFUSED" });
	process.nextTick(() => this.destroy(error));
	return this;
};
