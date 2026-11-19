import "server-only";
import type { Database } from "@everyfield/db/client";
import { runDueFeedbackPublication } from "../../server/jobs/feedback-publication.ts";
import { githubConfig, githubIssues } from "../../server/jobs/github.ts";
import { operatorMail } from "./mail.ts";
import { serverEnv, type ServerEnv } from "../../server/config.ts";

export function feedbackPublicationMount(db: Database, source: ServerEnv = serverEnv()) {
	const github = githubConfig(source);
	if (!github) return null;
	const config = { repository: github.repository, issues: githubIssues(github), operatorMail: operatorMail(source) };
	return (limit: number, until: number) => runDueFeedbackPublication(db, config, limit, until);
}
