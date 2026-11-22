import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, withPage } from "../setup.mjs";

const seed = () => fixture("invitation");
const UNAVAILABLE = "This page is not available";

let db = null;
async function database() {
	if (db) return db;
	if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
		}).trim();
		process.loadEnvFile(join(common, "..", "apps/web/.env.local"));
	}
	const { openSeedEnvironment } = await import("../seed-env.mts");
	const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
	const env = await openSeedEnvironment(seed().origin);
	db = {
		confirmAddress: (email) => env.admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`),
		seats: async (email) =>
			(
				await env.admin.execute(sql`SELECT count(*)::int n FROM seat s JOIN account a ON a.id=s.account_id
				JOIN auth_user u ON u.id=a.auth_user_id JOIN plant p ON p.id=s.plant_id
				WHERE u.email=${email} AND p.name='Harvest Point' AND s.accepted_at IS NOT NULL`)
			).rows[0].n,
		close: () => env.close(),
	};
	return db;
}
test.after(async () => {
	if (db) await db.close();
});

async function trusted(context) {
	await context.setExtraHTTPHeaders({ "x-vercel-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 254)}` });
}

async function neverUnavailable(page, step) {
	const shown = await page.getByText(UNAVAILABLE).count();
	assert.equal(shown, 0, `"${UNAVAILABLE}" shown ${step}`);
}

for (const [name, engine] of ENGINES) {
	test(
		`AC:TARGET-IDN-017 (${name}): a signed-out invitee creates an account from the seat link and is seated in the workspace`,
		{ timeout: 180_000 },
		() =>
			withPage(engine, async (page, context) => {
				const { link, email, workspace } = seed().joins[name].seat;
				await trusted(context);
				await page.goto(BASE + link);
				await page.getByRole("button", { name: "Create account and join" }).waitFor({ timeout: 60_000 });
				await page.getByLabel("Your name").fill("Jo Joiner");
				await page.getByLabel("Email").fill(email);
				await page.getByLabel("Create a password").fill(seed().password);
				await page.getByRole("button", { name: "Create account and join" }).click();
				await page.getByRole("heading", { name: "Confirm your email to join" }).waitFor({ timeout: 60_000 });
				await neverUnavailable(page, "after sign-up");
				await (await database()).confirmAddress(email);
				await page.getByRole("button", { name: "Continue", exact: true }).click();
				await page.getByRole("heading", { name: `You joined ${workspace}` }).waitFor({ timeout: 60_000 });
				await neverUnavailable(page, "after the accept");
				assert.equal(await (await database()).seats(email), 1);
				await page.getByRole("button", { name: "Continue", exact: true }).click();
				await page.waitForURL((url) => url.pathname === "/overview", { timeout: 60_000 });
				await hydrated(page);
				await page.getByText(workspace).first().waitFor({ timeout: 60_000 });
			}),
	);

	test(
		`AC:ADR1-004 (${name}): a resident accepts the residency link and lands in My residency`,
		{ timeout: 180_000 },
		() =>
			withPage(engine, async (page, context) => {
				const { link, email, organization } = seed().joins[name].resident;
				await trusted(context);
				await page.goto(BASE + link);
				await page.getByRole("button", { name: "Sign in to answer" }).click();
				await page.getByLabel("Email").fill(email);
				await page.getByLabel("Password", { exact: true }).fill(seed().password);
				await page.getByRole("button", { name: "Sign in and continue" }).click();
				await page.getByRole("button", { name: "Accept and join" }).click({ timeout: 60_000 });
				await page
					.getByRole("heading", { name: `You joined the residency at ${organization}` })
					.waitFor({ timeout: 60_000 });
				await neverUnavailable(page, "after the accept");
				await page.getByRole("link", { name: "Open My residency" }).click();
				await page.waitForURL((url) => url.pathname === "/my-residency", { timeout: 60_000 });
				await page.getByRole("heading", { name: "My residency" }).waitFor({ timeout: 60_000 });
				await page.getByText(`With ${organization}.`).waitFor();
			}),
	);
}
