import { spawnSync } from "node:child_process";
import { drive } from "./cron-driver.ts";
import { parseTestRecipients, qaDown, qaList, qaUp } from "./qa.ts";
import { fail, QaError } from "./store.ts";

const HELP = `QA previews for Nora (docs/runbooks/qa-preview.md). Run on Sebastian's Mac with neonctl and vercel logged in.
  qa up <branch> [--test-recipients a@x,b@x]
                   Neon branch off development, migrate, seed, Vercel preview of the branch head; prints the id and URL.
                   --test-recipients: full addresses that get real mail on this one deployment (EMAIL_TEST_RECIPIENTS);
                   the first is Ana Lee's address in both test churches
                   Never starts a driver: it says whether qa drive is running, else the command to start it
  qa drive         scheduled sends: calls /api/cron/jobs once a minute for every open preview, until Ctrl-C or SIGTERM.
                   Jonah starts it in a terminal outside any seat (a seat's processes end with its turn);
                   seats never start it. One per repository; previews that qa up adds join without a restart
  qa list          open QA previews: id, branch, URL, Neon branch, age, head
  qa down <id>     remove the cron secret (qa drive stops calling it within a minute), the alias, the deployment and the
                   Neon branch; a second run does nothing and succeeds`;

const usage = (args: string[], why = "") => {
	console.error(`${why || `Unknown command: qa ${args.filter(Boolean).join(" ")}`}\n\n${HELP}`);
	return 2;
};

function main(args: string[]): number {
	const [sub, arg, ...rest] = args;
	if (!sub || sub === "help" || sub === "--help") {
		console.log(HELP);
		return 0;
	}
	// `--test-recipients <list>` or `--test-recipients=<list>`, once, after the branch.
	let recipients: string[] = [];
	if (sub === "up" && rest.length) {
		const [flag, ...value] = rest[0]!.split("=");
		const raw = value.length ? value.join("=") : rest[1];
		if (flag !== "--test-recipients" || rest.length !== (value.length ? 1 : 2)) return usage(args);
		const parsed = parseTestRecipients(raw ?? "");
		if (typeof parsed === "string") return usage(args, `qa up refused before creating anything. ${parsed}`);
		recipients = parsed;
	}
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (top.status !== 0) fail("qa must run inside the everyfield repository.");
	const root = top.stdout.trim();
	if (sub === "up" && arg && !arg.startsWith("-")) return qaUp(root, arg, recipients);
	if (!rest.length) {
		if (sub === "down" && arg) return qaDown(root, arg);
		if (sub === "list" && !arg) return qaList(root);
		if (sub === "drive" && !arg) return drive(root);
	}
	return usage(args);
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof QaError)) throw error;
	console.error(`qa: ${error.message}`);
	process.exitCode = 1;
}
