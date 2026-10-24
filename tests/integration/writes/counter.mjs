import { registerHooks, createRequire } from "node:module";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { statementKind } from "./kinds.cjs";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const require = createRequire(root + "/packages/domain/package.json");
const ts = require("typescript");
const frames = new AsyncLocalStorage();
const output = process.env.EVF_WRITE_COUNTS;
const emit = (row) => {
	if (output) appendFileSync(output, JSON.stringify(row) + "\n");
};
const read =
	/^(?:get|read|list|describe|registrationEligible|addressHash|jobVisibility|append|current|registrationIntent|checkAggregateAccess)/;
const factories = {
	createOrganizationAdapter: "organizations",
	createSettingsProducer: "settings",
	createAccountCredentials: "settings",
	createOnboardingProducer: "onboarding",
	createInvitationService: "invitations",
	createSeatService: "seats",
	createIdentityService: "identity",
	createMailService: "mail",
	createNotificationService: "notifications",
	createNotificationProducer: "notifications",
	createDigestService: "digest",
	createLifecycleCleanup: "lifecycle.purge",
	referenceService: "reference",
	attemptBudget: "identity.budget",
	createTaskWriter: "tasks",
	createFollowUpWriter: "followups",
	createAttendanceWriter: "meetings",
};
const standalone = {
	"/packages/domain/src/early-access/index.ts": ["receiveAccessRequest"],
	"/packages/domain/src/people/core.ts": ["withPeopleWrite"],
	"/packages/domain/src/meetings/core.ts": ["withMeetingsWrite"],
	"/packages/domain/src/meetings/tokens.ts": ["answerRsvpToken"],
	"/packages/domain/src/meetings/notifications.ts": ["syncNotifications"],
	"/packages/domain/src/onboarding/core.ts": ["withOnboardingWrite"],
	"/packages/domain/src/settings/core.ts": ["withSettingsWrite"],
	"/packages/domain/src/tasks/core.ts": ["withTaskWrite"],
	"/packages/domain/src/followups/core.ts": ["withFollowUpWrite"],
	"/packages/domain/src/settings/avatar.ts": ["uploadAvatar"],
	"/packages/domain/src/people/fields/index.ts": ["uploadPersonPhoto"],
	"/packages/domain/src/people/csv/index.ts": ["executeBulkImport"],
	"/packages/domain/src/people/commitments/index.ts": [
		"getCommitmentDownload",
		"signCommitmentDocument",
		"saveCommitmentDocument",
	],
	"/packages/domain/src/settings/deletion.ts": ["issueRestrictedDeletionSession"],
	"/packages/domain/src/people/references.ts": ["detachAccountPersonLinks"],
	"/apps/web/src/server/jobs/queue.ts": [
		"enqueueJob",
		"enqueueJobs",
		"claimDue",
		"claimUnknownMail",
		"extendLease",
		"finishClaim",
		"recoverLease",
		"checkpoint",
		"scanPage",
	],
	"/apps/web/src/server/jobs/webhook.ts": ["receiveMailCallback", "replayStoredCallbacks"],
	"/apps/web/src/server/jobs/notifications.ts": ["sendDiscoveryAssociationReceipt", "sendOnboardingRelationships"],
};

export async function measure(name, body, options = {}) {
	const frame = { name, count: 0, writes: 0, rollbacks: 0, kinds: {} };
	const parent = frames.getStore()?.at(-1);
	if (parent && parent.first === undefined) parent.first = name;
	return frames.run([...(frames.getStore() ?? []), frame], async () => {
		const started = performance.now();
		let status = "threw";
		try {
			const result = await body();
			status = result?.status ?? "returned";
			return result;
		} finally {
			const { first, ...counts } = frame;
			// A shared wrapper outside any named check takes the operation it ran as its variant.
			const label = options.byFirst && first ? frame.name + ":" + first : frame.name;
			emit({ kind: "sample", ...counts, name: label, status, ms: Math.round(performance.now() - started) });
		}
	});
}
function decorate(prefix, value) {
	if (typeof value === "function")
		return function (...args) {
			return measure(prefix, () => Reflect.apply(value, this, args));
		};
	for (const key of Object.keys(value)) {
		// Pure helpers send no statement and return a value, not a promise.
		if (typeof value[key] !== "function" || key === "addressHash" || key === "queued") continue;
		const name = prefix + "." + key,
			fn = value[key];
		emit({ kind: "declaration", name, write: !read.test(key.split(".").at(-1)) });
		value[key] = function (...args) {
			const variant =
				prefix === "settings" && key === "saveSection"
					? ":" + args[2]?.input?.section
					: prefix === "identity" && key === "handle"
						? ":" + new URL(args[0].url).pathname.replace(/^\/api\/auth\//, "")
						: "";
			return measure(name + variant, () => Reflect.apply(fn, this, args));
		};
	}
	return value;
}
export function observeDatabase(db) {
	// pg-pool runs a queued connect callback inside the release of whichever request freed the client.
	// Binding it here keeps the caller's frames. Promise-style connect already keeps them.
	const connect = db.$client.connect;
	db.$client.connect = function (callback) {
		return Reflect.apply(connect, this, typeof callback === "function" ? [AsyncResource.bind(callback)] : []);
	};
	db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
			const kind = statementKind(text);
			for (const frame of frames.getStore() ?? []) {
				frame.count++;
				frame.kinds[kind] = (frame.kinds[kind] ?? 0) + 1;
				if (kind === "write") frame.writes++;
				// A native write's established run follows a first attempt that changed nothing: it counts as a retry.
				if (/^\s*ROLLBACK|^BEGIN \/\* evf:retry \*\//i.test(text)) frame.rollbacks++;
			}
			return Reflect.apply(query, this, args);
		};
	});
	return db;
}
/**
 * A shared native wrapper takes a variant: the named boundary check around it, or else the first operation it runs.
 * An operation with a larger reviewed budget gets its own limit; every other call keeps the wrapper's own budget.
 */
function measureWrapper(name, body) {
	const outer = frames.getStore()?.at(-1);
	return outer ? measure(name + ":" + outer.name, body) : measure(name, body, { byFirst: true });
}
globalThis.__evfWriteCounts = { measure, measureWrapper, decorate, observeDatabase };

registerHooks({
	load(url, context, next) {
		const loaded = next(url, context);
		if (!output || !url.startsWith("file:") || url.includes("/node_modules/")) return loaded;
		const path = fileURLToPath(url);
		if (!path.startsWith(root + "/")) return loaded;
		let source = typeof loaded.source === "string" ? loaded.source : loaded.source?.toString();
		if (!source) return loaded;
		if (path === root + "/packages/db/src/client.ts") {
			const pattern = /return drizzle\(\{\s*client:\s*pool,\s*schema\s*\}\);?/;
			if (!pattern.test(source)) throw Error("Statement counter must observe createDatabase's real pool");
			source = source.replace(
				pattern,
				"return globalThis.__evfWriteCounts.observeDatabase(drizzle({client:pool,schema}));",
			);
		} else if (
			path.includes("/packages/reference/src/") ||
			path.includes("/packages/domain/src/") ||
			path.includes("/apps/web/src/server/jobs/")
		) {
			const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
				edits = [];
			const names = standalone[path.slice(root.length)] ?? [];
			const localAliases = path.endsWith("/jobs/notifications.ts")
				? { enqueueMany: "notifications.enqueueMany", cancelForEntity: "notifications.cancelForEntity" }
				: {};
			function walk(n) {
				if (ts.isReturnStatement(n) && n.expression) {
					let ancestor = n.parent;
					while (
						ancestor &&
						!ts.isFunctionDeclaration(ancestor) &&
						!ts.isArrowFunction(ancestor) &&
						!ts.isMethodDeclaration(ancestor) &&
						!ts.isFunctionExpression(ancestor)
					)
						ancestor = ancestor.parent;
					const name = ancestor?.name?.getText(ast),
						prefix = factories[name];
					if (prefix)
						edits.push(
							[n.expression.getStart(ast), ` (globalThis.__evfWriteCounts.decorate(${JSON.stringify(prefix)},`],
							[n.expression.end, "))"],
						);
				}
				if (
					ts.isFunctionDeclaration(n) &&
					n.name &&
					n.body &&
					(names.includes(n.name.getText(ast)) || localAliases[n.name.getText(ast)])
				) {
					const name =
						localAliases[n.name.getText(ast)] ??
						path
							.slice(root.length + 1)
							.replace(/^packages\/domain\/src\/|^apps\/web\/src\/server\//, "")
							.replace(/\.ts$/, "") +
							"." +
							n.name.getText(ast);
					edits.push(
						[
							n.body.getStart(ast) + 1,
							`return await globalThis.__evfWriteCounts.measureWrapper(${JSON.stringify(name)},async()=>{`,
						],
						[n.body.end - 1, "});"],
					);
					emit({ kind: "declaration", name, write: true });
				}
				ts.forEachChild(n, walk);
			}
			walk(ast);
			for (const [offset, text] of edits.sort((a, b) => b[0] - a[0]))
				source = source.slice(0, offset) + text + source.slice(offset);
			const objects = {
				"/packages/domain/src/people/people.ts": { peopleWriter: "people", accountPersonProducer: "accountPerson" },
				"/packages/domain/src/people/fields/index.ts": { personFields: "people" },
				"/packages/domain/src/people/assessments/index.ts": { assessments: "people" },
				"/packages/domain/src/people/interviews/index.ts": { interviews: "people" },
				"/packages/domain/src/people/commitments/index.ts": { commitments: "people" },
				"/packages/domain/src/people/merge/index.ts": { peopleMerge: "people" },
				"/packages/domain/src/people/unmerge/index.ts": { peopleUnmerge: "people" },
				"/packages/domain/src/people/corrections/index.ts": { recordCorrections: "people" },
				"/packages/domain/src/meetings/meetings.ts": { meetingsWriter: "meetings" },
				"/packages/domain/src/meetings/guests.ts": { guestsWriter: "meetings" },
				"/packages/domain/src/meetings/venues.ts": { venuesWriter: "venues" },
				"/packages/domain/src/meetings/analytics.ts": { attendanceReader: "meetings" },
				"/packages/domain/src/teams/commands.ts": { teamsWriter: "teams" },
				"/packages/domain/src/teams/training/commands.ts": { trainingWriter: "teams" },
				"/packages/domain/src/teams/training/reads.ts": { trainingReader: "teams" },
				"/packages/domain/src/teams/roster.ts": { rosterWriter: "meetings" },
			};
			for (const [name, prefix] of Object.entries(objects[path.slice(root.length)] ?? {}))
				source += `\nglobalThis.__evfWriteCounts.decorate(${JSON.stringify(prefix)},${name});`;
		}
		return { ...loaded, source };
	},
});
