import { createServer } from "node:http";

const server = createServer((request, response) => response.end("stub " + process.env.STUB_ORIGIN));
server.on("error", (error) => {
	console.error(error.message);
	process.exit(1);
});
server.listen(Number(process.argv[2]), "127.0.0.1", () => console.log("Ready in 0ms"));
