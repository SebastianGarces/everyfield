const net = require("node:net");

const port = Number(process.env.EVF_HELD_PORT);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (first, ...rest) {
	if (Number(first) !== port) return Reflect.apply(listen, this, [first, ...rest]);
	net.Server.prototype.listen = listen;
	return Reflect.apply(listen, this, [{ fd: 3 }, ...rest.filter((arg) => typeof arg === "function")]);
};
