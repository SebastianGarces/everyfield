// Identity screens (WP-005/ui): the guards a silent break would turn into account enumeration, an open redirect, a
// spent or leaked reset proof, or a lost session. Each row fails when its guard is removed.
//   INV-nonenumeration: a wrong password and a blocked or unknown account read the same; recovery and registration
//     answer every address the same way.
//   INV-safe-return: only a local path survives sign-in, on the request and on the way back.
//   INV-proof-link: reset and confirmation proofs leave the address bar, are spent only by a press, and a reset never
//     signs in by itself.
//   INV-session: the signed-in state, sign-out and an ended session lead back to sign-in.
//   BUG-PR113 focus: an invalid field with keyboard focus still shows the focus ring (shared Input, D38).
// The API answers are stubbed at the browser boundary with contract-shaped bodies, so the rows pin the screens; the
// real WP-005 API has its own database tests. It runs against a running app through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage as onPreview } from "../setup.mjs";

const CORRELATION = "6f1c2f6e-4a8e-4c55-9a39-2f4b7c2d9e10";
const ACCOUNT = "0b0f6a7e-1d6f-4f7e-8c35-5b8f5c0f4d21";
const SESSION = "4d3c2b1a-0f9e-4d8c-8b7a-6a5b4c3d2e1f";
const refusal = (code, details = {}) => ({
	status: code === "rate_limited" ? 429 : code === "invalid_proof" ? 400 : 401,
	body: {
		code,
		details,
		correlationId: CORRELATION,
		retry: code === "rate_limited" ? "same_request" : "never",
	},
});
const ok = (body) => ({ status: 200, body });
const UNAUTHENTICATED = ok({ status: "unauthenticated" });
const OPEN = ok({
	mode: "open",
	kinds: ["plant_precreation", "discovery", "sending_church", "sending_network"],
	invitation: { status: "unavailable" },
});

/**
 * Opens a page with /api/auth stubbed. `api` maps a path to a reply, a list of replies (one per call; the last one
 * repeats) or a function of the requests sent so far. Gives the page and the requests sent, as { path, body }.
 */
const withPage = (engine, api, run, { width = 1440 } = {}) =>
	onPreview(
		engine,
		async (page, context) => {
			const sent = [];
			const calls = {};
			await context.route("**/api/auth/**", async (route) => {
				const request = route.request();
				const path = new URL(request.url()).pathname.replace("/api/auth/", "");
				sent.push({ path, body: request.postData() ? JSON.parse(request.postData()) : null });
				const given = api[path] ?? (path === "get-session" ? UNAUTHENTICATED : refusal("unavailable"));
				const replies = [typeof given === "function" ? given(sent) : given].flat();
				const reply = replies[Math.min((calls[path] = (calls[path] ?? -1) + 1), replies.length - 1)];
				await route.fulfill({
					status: reply.status,
					contentType: "application/json",
					body: JSON.stringify(reply.body),
				});
			});
			await run(page, sent);
		},
		{ width },
	);

const alertText = async (page) => (await page.getByRole("alert").filter({ hasText: /\w/ }).innerText()).trim();
// The session the server would report: signed in until a sign-out, or until the second "other devices" call fails.
const sessionUntil = (status, ended) => (sent) =>
	ended(sent)
		? UNAUTHENTICATED
		: ok({ status, accountId: ACCOUNT, sessionId: SESSION, expiresAt: new Date(Date.now() + 864e5).toISOString() });

// --ef-focus in each theme (design/handoff/tokens.css).
const FOCUS = { light: "rgb(28, 91, 181)", dark: "rgb(169, 207, 255)" };

for (const [name, engine] of ENGINES) {
	test(
		`AC:TARGET-IDN-001 INV-nonenumeration (${name}): sign-in refuses a wrong password and a blocked account alike`,
		{ timeout: 60_000 },
		() =>
			withPage(
				engine,
				{
					"sign-in/email": [
						refusal("invalid_credentials"),
						refusal("unauthenticated"),
						refusal("rate_limited", { retryAt: new Date(Date.now() + 3600_000).toISOString() }),
					],
				},
				async (page, sent) => {
					await page.goto(BASE + "/signin");
					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					assert.equal(await page.getByText("Enter an email address, like name@church.org.").count(), 1);
					assert.equal(sent.filter((r) => r.path === "sign-in/email").length, 0, "an invalid form sends nothing");

					await page.getByLabel("Email").fill("  Ana@HarvestPoint.org ");
					await page.getByLabel("Password", { exact: true }).fill("wrong-password");
					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					const first = await alertText(page);
					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					await page.getByRole("alert").filter({ hasText: /\w/ }).waitFor();
					assert.equal(first, "Email or password is incorrect.");
					assert.equal(await alertText(page), first, "a blocked account reads like a wrong password");
					assert.equal(sent.find((r) => r.path === "sign-in/email").body.email, "ana@harvestpoint.org");

					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					await page.getByText(/^Too many attempts\. Try again after /).waitFor();
				},
			),
	);

	test(
		`AC:TARGET-IDN-028 INV-safe-return (${name}): only a local return path survives sign-in`,
		{ timeout: 60_000 },
		async () => {
			const signedIn = (returnTo) => ok({ status: "signed_in", returnTo });
			const destination = async (page, path) =>
				page.route(BASE + path, (route) =>
					route.fulfill({ contentType: "text/html", body: "<main>Signed in destination</main>" }),
				);
			await withPage(engine, { "sign-in/email": signedIn("//evil.example/steal") }, async (page, sent) => {
				await destination(page, "/onboarding");
				await page.goto(BASE + "/signin?returnTo=%2F%2Fevil.example%2Fsteal");
				await page.getByLabel("Email").fill("ana@harvestpoint.org");
				await page.getByLabel("Password", { exact: true }).fill("a-long-password");
				await page.getByRole("button", { name: "Sign in", exact: true }).click();
				await page.waitForURL((url) => url.pathname === "/onboarding" && !url.search);
				assert.equal(new URL(page.url()).origin, new URL(BASE).origin, "a protocol-relative echo never leaves");
				assert.equal(
					"returnTo" in sent.find((r) => r.path === "sign-in/email").body,
					false,
					"the unsafe path is not sent",
				);
			});
			await withPage(engine, { "sign-in/email": signedIn("/people?view=list") }, async (page, sent) => {
				await destination(page, "/people?view=list");
				await page.goto(BASE + "/signin?returnTo=%2Fpeople%3Fview%3Dlist");
				await page.getByRole("heading", { name: "Welcome back" }).waitFor();
				assert.equal(await page.getByText("Sign in to continue.").count(), 1);
				await page.getByLabel("Email").fill("ana@harvestpoint.org");
				await page.getByLabel("Password", { exact: true }).fill("a-long-password");
				await page.getByRole("button", { name: "Sign in", exact: true }).click();
				await page.waitForURL((url) => url.pathname === "/people" && url.search === "?view=list");
				assert.equal(sent.find((r) => r.path === "sign-in/email").body.returnTo, "/people?view=list");
			});
		},
	);

	test(
		`AC:TARGET-IDN-009 INV-nonenumeration (${name}): recovery answers every address the same way`,
		{ timeout: 60_000 },
		() =>
			withPage(
				engine,
				{
					"request-password-reset": [
						ok({ status: "accepted" }),
						ok({ status: "accepted" }),
						refusal("rate_limited", { retryAt: new Date(Date.now() + 3600_000).toISOString() }),
					],
				},
				async (page) => {
					const answers = [];
					for (const email of ["known@harvestpoint.org", "nobody@harvestpoint.org"]) {
						await page.goto(BASE + "/recover-password");
						await page.getByLabel("Email").fill(email);
						await page.getByRole("button", { name: "Send reset link" }).click();
						await page.getByRole("heading", { name: "Check your email" }).waitFor();
						answers.push((await page.getByRole("main").innerText()).replace(email, "EMAIL"));
					}
					assert.equal(answers[0], answers[1], "a known and an unknown address get the same page");
					assert.match(answers[0], /If an account uses EMAIL, it gets a link/);
					await page.getByRole("button", { name: "Send another link" }).click();
					await page.getByText(/^Too many reset requests for this email\. Try again after /).waitFor();
				},
			),
	);

	test(
		`AC:TARGET-IDN-009 INV-proof-link (${name}): a reset proof leaves the URL and never signs in`,
		{ timeout: 60_000 },
		async () => {
			const reset = async (page) => {
				await page.goto(BASE + "/reset-password?token=proof-123");
				await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
				await page.waitForURL((url) => url.pathname === "/reset-password" && !url.search);
				await page.getByLabel("New password", { exact: true }).fill("a-new-password");
				await page.getByLabel("Confirm new password").fill("a-new-passwore");
				await page.getByRole("button", { name: "Reset password" }).click();
				assert.equal(await page.getByText("Enter the same password again.").count(), 1);
				await page.getByLabel("Confirm new password").fill("a-new-password");
				await page.getByRole("button", { name: "Reset password" }).click();
			};
			await withPage(engine, { "reset-password": refusal("invalid_proof") }, async (page) => {
				await reset(page);
				await page.getByRole("heading", { name: "This link has expired" }).waitFor();
				assert.equal(
					await page.getByRole("link", { name: "Ask for a new link" }).getAttribute("href"),
					"/recover-password",
				);
			});
			await withPage(
				engine,
				{ "reset-password": ok({ status: "password_reset", next: "sign_in" }) },
				async (page, sent) => {
					await reset(page);
					await page.getByRole("heading", { name: "Your password is reset" }).waitFor();
					const posted = sent.filter((r) => r.path === "reset-password");
					assert.deepEqual(
						posted.map((r) => r.body),
						[{ proof: "proof-123", newPassword: "a-new-password", confirmPassword: "a-new-password" }],
					);
					assert.deepEqual(
						sent.filter((r) => r.path === "sign-in/email"),
						[],
						"a reset never signs in by itself",
					);
					assert.equal(new URL(page.url()).pathname, "/reset-password");
				},
			);
			await withPage(engine, {}, async (page) => {
				await page.goto(BASE + "/reset-password");
				await page.getByRole("heading", { name: "This link is incomplete" }).waitFor();
			});
		},
	);

	test(
		`INV-proof-link (${name}): opening a confirmation link spends nothing until the press`,
		{ timeout: 60_000 },
		() =>
			withPage(engine, { "verify-email": ok({ status: "email_verified" }) }, async (page, sent) => {
				await page.goto(BASE + "/verify-email?token=proof-456");
				await page.getByRole("heading", { name: "Confirm your email" }).waitFor();
				await page.waitForURL((url) => !url.search);
				await page.waitForTimeout(300);
				assert.deepEqual(
					sent.filter((r) => r.path === "verify-email"),
					[],
					"a link scanner's GET spends nothing",
				);
				await page.getByRole("button", { name: "Confirm email" }).click();
				await page.getByRole("heading", { name: "Your email is confirmed" }).waitFor();
				assert.deepEqual(
					sent.filter((r) => r.path === "verify-email").map((r) => r.body),
					[{ proof: "proof-456" }],
				);
			}),
	);

	test(
		`AC:TARGET-IDN-002 AC:TARGET-IDN-030 INV-nonenumeration (${name}): registration resumes through sign-in without saying the account exists`,
		{ timeout: 60_000 },
		async () => {
			await withPage(
				engine,
				{
					"registration-options": OPEN,
					register: ok({ status: "continue_identity_proof" }),
					"sign-in/email": refusal("invalid_credentials"),
				},
				async (page, sent) => {
					await page.goto(BASE + "/register");
					await page.getByRole("radio", { name: "We’re a sending church" }).click();
					await page.getByLabel("Your name").fill("Ana Ruiz");
					await page.getByLabel("Church name").fill("Harvest Point");
					await page.getByLabel("Email").fill("ana@harvestpoint.org");
					await page.getByLabel("Password", { exact: true }).fill("short");
					await page.getByRole("button", { name: "Create account" }).click();
					assert.equal(await page.getByText("Use at least 8 characters.").count(), 1);
					assert.equal(sent.filter((r) => r.path === "register").length, 0);
					await page.getByLabel("Password", { exact: true }).fill("a-long-password");
					await page.getByRole("button", { name: "Create account" }).click();
					await page.getByRole("heading", { name: "Sign in to continue" }).waitFor();
					const body = sent.find((r) => r.path === "register").body;
					assert.equal(body.kind, "sending_church");
					assert.equal(body.organizationName, "Harvest Point");
					assert.equal(await page.getByLabel("Email").inputValue(), "ana@harvestpoint.org");
					assert.equal(
						await page.getByRole("alert").filter({ hasText: /\w/ }).count(),
						0,
						"a failed resume says nothing about the account",
					);
				},
			);
			await withPage(
				engine,
				{ "registration-options": ok({ mode: "closed", kinds: [], invitation: { status: "unavailable" } }) },
				async (page) => {
					await page.goto(BASE + "/register");
					await page.getByRole("heading", { name: "Sign-up is closed" }).waitFor();
					assert.equal(await page.getByRole("button", { name: "Create account" }).count(), 0);
				},
			);
		},
	);

	test(
		`AC:TARGET-IDN-001 INV-session (${name}): signed-in state, sign-out and an ended session`,
		{ timeout: 60_000 },
		() =>
			withPage(
				engine,
				{
					"get-session": sessionUntil(
						"pending_domain",
						(sent) => sent.filter((r) => r.path === "revoke-other-sessions").length > 1,
					),
					"revoke-other-sessions": [ok({ status: "other_sessions_revoked" }), refusal("unauthenticated")],
					"sign-out": ok({ status: "signed_out" }),
				},
				async (page, sent) => {
					await page.goto(BASE + "/signin");
					await page.getByRole("heading", { name: "You’re signed in" }).waitFor();
					assert.equal(
						await page.getByLabel("Password", { exact: true }).count(),
						0,
						"a signed-in visitor gets no form",
					);
					await page.getByRole("button", { name: "Sign out other devices" }).click();
					await page.getByRole("status").filter({ hasText: "Your other devices are signed out." }).waitFor();
					await page.getByRole("button", { name: "Sign out other devices" }).click();
					await page.getByRole("heading", { name: "Welcome back" }).waitFor();
					assert.equal(new URL(page.url()).pathname, "/signin", "an ended session goes to sign-in");
					assert.equal(sent.filter((r) => r.path === "sign-out").length, 0);
				},
			).then(() =>
				withPage(
					engine,
					{
						"get-session": sessionUntil("active", (sent) => sent.some((r) => r.path === "sign-out")),
						"sign-out": ok({ status: "signed_out" }),
					},
					async (page, sent) => {
						await page.goto(BASE + "/signin");
						await page.getByRole("link", { name: "Continue" }).waitFor();
						await page.getByRole("button", { name: "Sign out", exact: true }).click();
						await page.getByRole("heading", { name: "Welcome back" }).waitFor();
						assert.deepEqual(
							sent.filter((r) => r.path === "sign-out").map((r) => r.body),
							[{}],
						);
					},
				),
			),
	);

	for (const theme of ["light", "dark"])
		test(
			`BUG-PR113 focus (${name}, ${theme}): an invalid field with keyboard focus shows the focus ring`,
			{ timeout: 60_000 },
			() =>
				withPage(engine, {}, async (page) => {
					await page.context().addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
					await page.goto(BASE + "/signin");
					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					const email = page.getByLabel("Email");
					const password = page.getByLabel("Password", { exact: true });
					assert.equal(await email.getAttribute("aria-invalid"), "true");
					assert.equal(await password.getAttribute("aria-invalid"), "true");
					// Keyboard focus: move from Password back to Email with Shift+Tab.
					await password.focus();
					await page.keyboard.press("Shift+Tab");
					assert.equal(
						await email.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")),
						true,
					);
					const ring = (input) => input.evaluate((el) => getComputedStyle(el.parentElement).boxShadow);
					const focused = await ring(email),
						resting = await ring(password);
					assert.ok(focused.includes(FOCUS[theme]), `focused invalid box draws the focus color: ${focused}`);
					assert.notEqual(focused, resting, "focus changes the invalid box");
				}),
		);
}
