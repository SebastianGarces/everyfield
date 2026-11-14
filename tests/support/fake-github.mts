import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// A fake GitHub REST API for the feedback publisher, on a local port: it answers only the two calls the publisher may
// make (create an issue, search issues) and records every request exactly as it arrived, so a test can read what
// "GitHub" received. Nothing here reaches github.com. A test can delay or drop a reply after the issue is made, fail
// the search, rename a repository or close an issue.

export type FakeIssue = {
	repositoryId: number;
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	url: string;
};
export type FakeRequest = { method: string; path: string; headers: Record<string, string>; body: string };

export async function fakeGitHub(repositories: Record<string, number>) {
	const names = new Map(Object.entries(repositories));
	const issues: FakeIssue[] = [];
	const requests: FakeRequest[] = [];
	const behavior = {
		/** Milliseconds to wait after making the issue and before answering: past the client's timeout, the reply is lost. */
		createReplyDelayMs: 0,
		/** The search answers this status instead of results. */
		searchStatus: 200,
		/** The create answers this status and makes nothing, when set. */
		createStatus: null as number | null,
	};
	const read = (request: IncomingMessage) =>
		new Promise<string>((done) => {
			let text = "";
			request.on("data", (chunk) => (text += chunk));
			request.on("end", () => done(text));
		});
	const server = createServer(async (request, response) => {
		const body = await read(request);
		const url = new URL(request.url ?? "/", "http://fake.test");
		const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)]));
		requests.push({ method: request.method ?? "", path: url.pathname + url.search, headers, body });
		const answer = (status: number, value: unknown) => {
			if (response.destroyed) return;
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		const create = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
		if (request.method === "POST" && create) {
			const id = names.get(create[1]!);
			if (id === undefined) return answer(404, { message: "Not Found" });
			if (behavior.createStatus !== null) return answer(behavior.createStatus, { message: "Refused" });
			const input = JSON.parse(body) as { title: string; body: string };
			const number = issues.filter((i) => i.repositoryId === id).length + 1;
			const issue: FakeIssue = {
				repositoryId: id,
				number,
				title: input.title,
				body: input.body,
				state: "open",
				url: `https://github.fake.test/${create[1]}/issues/${number}`,
			};
			issues.push(issue);
			if (behavior.createReplyDelayMs) await new Promise((wait) => setTimeout(wait, behavior.createReplyDelayMs));
			return answer(201, {
				id: 9000 + issues.length,
				number,
				html_url: issue.url,
				title: issue.title,
				body: issue.body,
			});
		}
		if (request.method === "GET" && url.pathname === "/search/issues") {
			if (behavior.searchStatus !== 200) return answer(behavior.searchStatus, { message: "Search failed" });
			const q = url.searchParams.get("q") ?? "";
			const repo = /repo:(\S+)/.exec(q)?.[1];
			const words = /"([^"]+)"/.exec(q)?.[1] ?? "";
			const id = repo ? names.get(repo) : undefined;
			if (id === undefined) return answer(422, { message: "Validation Failed" });
			const items = issues
				.filter((i) => i.repositoryId === id && i.body.includes(words))
				.map((i) => ({ number: i.number, html_url: i.url, title: i.title, body: i.body, state: i.state }));
			return answer(200, { total_count: items.length, incomplete_results: false, items });
		}
		answer(404, { message: "Not Found" });
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const { port } = server.address() as AddressInfo;
	return {
		api: `http://127.0.0.1:${port}`,
		issues,
		requests,
		behavior,
		/** Renames a repository: its id and issues stay, its old name stops answering. */
		rename(from: string, to: string) {
			const id = names.get(from)!;
			names.delete(from);
			names.set(to, id);
		},
		close(number: number, repositoryId: number) {
			issues.find((i) => i.number === number && i.repositoryId === repositoryId)!.state = "closed";
		},
		stop: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}
