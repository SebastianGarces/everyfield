import { z } from "zod";

// The feedback publisher's GitHub client (REQ-ADM-003). It makes exactly two calls: create one issue with a title and a
// body, and search one repository's issues for a reference. Nothing else, no labels, assignees, comments, branches,
// pull requests or workflow triggers, is ever sent. The repository and token come from configuration. Each call ends
// after 10 seconds. Relative imports and no "server-only", so node tests can import it by path.

const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_API = "https://api.github.com";

export type IssueLink = { number: number; url: string };
/** created: GitHub answered with the issue. refused: GitHub said no, so nothing was created. unknown: no clear answer. */
export type CreateOutcome = { kind: "created"; issue: IssueLink } | { kind: "refused" } | { kind: "unknown" };
/** found: the issues whose body carries the reference (none, one or several). failed: the search gave no full answer. */
export type SearchOutcome = { kind: "found"; issues: IssueLink[] } | { kind: "failed" };
export interface IssueClient {
	create(repository: string, issue: { title: string; body: string }): Promise<CreateOutcome>;
	search(repository: string, reference: string): Promise<SearchOutcome>;
}

/** "owner/name" as GitHub spells a repository. */
const repositoryName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);

export type GitHubConfig = {
	/** The repository the next new intent targets: its numeric id and owner/name. */
	repository: { id: string; name: string };
	token: string;
	/** The API origin: GitHub's own unless a development or test fake is named. */
	api: string;
};
const env = z.object({
	FEEDBACK_GITHUB_REPOSITORY: repositoryName,
	FEEDBACK_GITHUB_REPOSITORY_ID: z.string().regex(/^[1-9]\d{0,18}$/),
	FEEDBACK_GITHUB_TOKEN: z.string().min(1),
	FEEDBACK_GITHUB_API: z.url().optional(),
});
/** The deployment's feedback repository, or null when it has none configured: then nothing is sent to GitHub. */
export function githubConfig(source: Readonly<Record<string, string | undefined>> = process.env): GitHubConfig | null {
	const parsed = env.safeParse(source);
	if (!parsed.success) return null;
	const v = parsed.data;
	return {
		repository: { id: v.FEEDBACK_GITHUB_REPOSITORY_ID, name: v.FEEDBACK_GITHUB_REPOSITORY },
		token: v.FEEDBACK_GITHUB_TOKEN,
		api: new URL(v.FEEDBACK_GITHUB_API ?? GITHUB_API).origin,
	};
}

const issueReply = z.object({ number: z.number().int().positive(), html_url: z.url() });
const searchReply = z.object({
	incomplete_results: z.boolean(),
	items: z.array(
		z.object({
			number: z.number().int().positive(),
			html_url: z.url(),
			body: z.string().nullable().optional(),
			pull_request: z.unknown().optional(),
		}),
	),
});
/** GitHub's answers that mean the create was refused and made nothing. Any other answer may have created the issue. */
const REFUSED = new Set([400, 401, 404, 410, 422]);

export function githubIssues(
	config: Pick<GitHubConfig, "token" | "api">,
	request: typeof fetch = fetch,
	timeoutMs = GITHUB_TIMEOUT_MS,
): IssueClient {
	const call = (path: string, init: RequestInit = {}) =>
		request(`${config.api}${path}`, {
			...init,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${config.token}`,
				"x-github-api-version": "2022-11-28",
				"user-agent": "everyfield-feedback",
				...(init.body ? { "content-type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	return {
		async create(repository, issue) {
			const name = repositoryName.parse(repository);
			try {
				const response = await call(`/repos/${name}/issues`, {
					method: "POST",
					body: JSON.stringify({ title: issue.title, body: issue.body }),
				});
				if (REFUSED.has(response.status)) return { kind: "refused" };
				if (response.status !== 201) return { kind: "unknown" };
				const found = issueReply.safeParse(await response.json());
				return found.success
					? { kind: "created", issue: { number: found.data.number, url: found.data.html_url } }
					: { kind: "unknown" };
			} catch {
				return { kind: "unknown" };
			}
		},
		async search(repository, reference) {
			const name = repositoryName.parse(repository);
			const q = `"${reference}" repo:${name} is:issue in:body`;
			try {
				const response = await call(`/search/issues?q=${encodeURIComponent(q)}&per_page=20`);
				if (response.status !== 200) return { kind: "failed" };
				const found = searchReply.safeParse(await response.json());
				if (!found.success || found.data.incomplete_results) return { kind: "failed" };
				// Search matches words loosely; only a body that carries this exact reference is this report's issue.
				const issues = found.data.items
					.filter((item) => !item.pull_request && item.body?.includes(`Reference: ${reference}.`))
					.map((item) => ({ number: item.number, url: item.html_url }));
				return { kind: "found", issues };
			} catch {
				return { kind: "failed" };
			}
		},
	};
}
