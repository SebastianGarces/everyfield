import { createServer } from "node:http";

createServer((request, response) => response.end("stub")).listen(Number(process.argv[2]), "127.0.0.1", () =>
	console.log("Ready in 0ms"),
);
