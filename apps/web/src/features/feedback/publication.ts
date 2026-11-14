import "server-only";
import type { Database } from "@everyfield/db/client";
import { runDueFeedbackPublication } from "../../server/jobs/feedback-publication.ts";
import { githubConfig, githubIssues } from "../../server/jobs/github.ts";
import { operatorMail } from "./mail.ts";

// The scheduled runner's feedback publication (WP-049B), as the deployment configures it. Relative imports, so node
// tests can import it by path.

/**
 * One bounded batch of feedback publication with the deployment's repository, token and operator inbox. Null when no
 * feedback repository is configured: nothing is sent to GitHub, no operator email is queued, and feedback waits.
 */
export function feedbackPublicationMount(
	db: Database | null,
	source: Readonly<Record<string, string | undefined>> = process.env,
) {
	const github = githubConfig(source);
	if (!db || !github) return null;
	const config = { repository: github.repository, issues: githubIssues(github), operatorMail: operatorMail(source) };
	return (limit: number, until: number) => runDueFeedbackPublication(db, config, limit, until);
}
