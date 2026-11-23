import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("./held-port.cjs", import.meta.url));

export async function holdPort(host) {
	const holder = createServer();
	await new Promise((resolve, reject) => holder.once("error", reject).listen(0, host, resolve));
	holder.unref();
	const { port } = holder.address();
	return {
		port,
		spawn(command, args, { env, stdio, ...options }) {
			const child = spawn(command, args, {
				...options,
				env: {
					...env,
					EVF_HELD_PORT: String(port),
					NODE_OPTIONS: [env.NODE_OPTIONS, "--require=" + preload].filter(Boolean).join(" "),
				},
				stdio: [...stdio, holder._handle.fd],
			});
			holder.close();
			return child;
		},
	};
}
