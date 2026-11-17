import "server-only";
import type { Database } from "@everyfield/db/client";
import { runDueFeedbackPublication } from "../../server/jobs/feedback-publication.ts";
import { githubConfig, githubIssues } from "../../server/jobs/github.ts";
import { operatorMail } from "./mail.ts";

export function feedbackPublicationMount(
	db: Database | null,
	source: Readonly<Record<string, string | undefined>> = process.env,
) {
	const github = githubConfig(source);
	if (!db || !github) return null;
	const config = { repository: github.repository, issues: githubIssues(github), operatorMail: operatorMail(source) };
	return (limit: number, until: number) => runDueFeedbackPublication(db, config, limit, until);
}
