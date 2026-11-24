import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { identityError } from "../../../packages/contracts/src/identity/results.ts";
import type { Refusal } from "../../../apps/web/src/features/identity/api.ts";
import type { Screen } from "../../../apps/web/src/features/identity/messages.ts";
import { mount } from "../evry/fake-dom.mts";

const feature = "../../../apps/web/src/features/identity/";
const { refusalMessage } = await import("../../../apps/web/src/features/identity/messages.ts");
const { SignInForm } = await import(`${feature}SignInScreen.tsx`);
const { RegisterScreen } = await import(`${feature}RegisterScreen.tsx`);
const { RecoverScreen, ResetPasswordScreen, VerifyEmailScreen } = await import(`${feature}RecoveryScreens.tsx`);
const { SessionActions } = await import(`${feature}SessionActions.tsx`);

const SCREENS: Record<Screen, true> = { sign_in: true, register: true, recover: true, reset: true, session: true };
const screens = Object.keys(SCREENS) as Screen[];

test("INV-account-privacy: wrong credentials and no session read the same on every sign-in, sign-up and recovery screen", () => {
	const words = screens.flatMap((screen) =>
		(["invalid_credentials", "unauthenticated"] as const).map((code) => [
			screen === "session" ? "session" : "elsewhere",
			refusalMessage(screen, { status: "refused", code, retryAt: null }),
		]),
	);
	assert.deepEqual(
		[...new Set(words.filter(([where]) => where === "elsewhere").map(([, text]) => text))],
		["Email or password is incorrect."],
	);
	assert.deepEqual(
		[...new Set(words.filter(([where]) => where === "session").map(([, text]) => text))],
		["Your session ended. Sign in again."],
	);
});

class Submitted {
	readonly fields: Record<string, string>;
	constructor(form: { fields: Record<string, string> }) {
		this.fields = form.fields;
	}
	get(name: string) {
		return this.fields[name] ?? null;
	}
}
Object.assign(globalThis, {
	FormData: Submitted,
	location: Object.assign(new URL("https://app.example.test/settings/account"), { assign() {} }),
});

const RETRY_AT = "2026-10-21T12:00:00.000Z";
type Answer = { refusal: Refusal; reply: () => Response };
const ANSWERS: Answer[] = [
	...identityError.options.map((option): Answer => {
		const error = { code: option.shape.code.value, retry: option.shape.retry.value };
		const limited = error.code === "rate_limited";
		const parsed = identityError.safeParse({
			code: error.code,
			correlationId: "11111111-1111-4111-8111-111111111111",
			retry: error.retry,
			details: limited ? { retryAt: RETRY_AT } : {},
		});
		assert.ok(parsed.success, `${error.code}: ${parsed.error}`);
		return {
			refusal: { status: "refused", code: error.code, retryAt: limited ? RETRY_AT : null },
			reply: () => Response.json(parsed.data, { status: 400 }),
		};
	}),
	{
		refusal: { status: "lost" },
		reply: () => {
			throw new TypeError("offline");
		},
	},
];
const OPTIONS = { mode: "open", kinds: ["plant_precreation"], invitation: { status: "unavailable" } };
function server(replies: Record<string, () => Response>) {
	globalThis.fetch = (async (url: string) => {
		const path = String(url).replace("/api/auth/", "");
		const reply = replies[path];
		if (!reply) throw Error(`unexpected ${path}`);
		return reply();
	}) as typeof fetch;
}

const ACCOUNT = { name: "Ana Lee", email: "ana@example.test", password: "a long password" };
const PASSWORDS = { newPassword: "a long password", confirmPassword: "a long password" };
type Place = {
	screen: Screen;
	component: unknown;
	props: Record<string, unknown>;
	path: string;
	send: (at: Awaited<ReturnType<typeof mount>>) => Promise<unknown>;
	says?: (refusal: Refusal) => readonly string[] | undefined;
};
const codeOf = (refusal: Refusal) => (refusal.status === "refused" ? refusal.code : null);
const EXPIRED = {
	reset: [
		"This link has expired",
		"A reset link works once and expires after 1 hour. Ask for a new one to choose a password.",
		"Ask for a new link",
	],
	verify: [
		"This link has expired",
		"A confirmation link works once and expires. Sign in to ask for a new one.",
		"Sign in",
	],
};
const SIGN_OUT_FAILED = "Unable to sign out. Check your connection and try again.";
const PLACES: Record<string, Place> = {
	"sign in": {
		screen: "sign_in",
		component: SignInForm,
		props: { returnTo: null },
		path: "sign-in/email",
		send: (at) => at.submit(ACCOUNT),
	},
	"sign up": {
		screen: "register",
		component: RegisterScreen,
		props: {},
		path: "register",
		send: (at) => at.submit(ACCOUNT),
	},
	recovery: {
		screen: "recover",
		component: RecoverScreen,
		props: {},
		path: "request-password-reset",
		send: (at) => at.submit(ACCOUNT),
	},
	reset: {
		screen: "reset",
		component: ResetPasswordScreen,
		props: { linked: true },
		path: "reset-password",
		send: (at) => at.submit(PASSWORDS),
		says: (refusal) => (codeOf(refusal) === "invalid_proof" ? EXPIRED.reset : undefined),
	},
	verification: {
		screen: "session",
		component: VerifyEmailScreen,
		props: { linked: true },
		path: "verify-email",
		send: (at) => at.click("Confirm email"),
		says: (refusal) => (codeOf(refusal) === "invalid_proof" ? EXPIRED.verify : undefined),
	},
	"other sessions": {
		screen: "session",
		component: SessionActions,
		props: {},
		path: "revoke-other-sessions",
		send: (at) => at.click("Sign out other devices"),
		says: (refusal) => (codeOf(refusal) === "unauthenticated" ? [] : undefined),
	},
	"sign out": {
		screen: "session",
		component: SessionActions,
		props: {},
		path: "sign-out",
		send: (at) => at.click("Sign out"),
		says: () => [SIGN_OUT_FAILED],
	},
};

for (const [name, place] of Object.entries(PLACES))
	test(`INV-account-privacy: a refused ${name} adds only refusalMessage's words to the screen, and the one named exception is the same for every account`, async () => {
		for (const { refusal, reply } of ANSWERS) {
			server({ "registration-options": () => Response.json(OPTIONS), [place.path]: reply });
			const at = await mount(place.component, place.props);
			const before = at.lines();
			await place.send(at);
			const added = at.lines().filter((line) => !before.includes(line));
			assert.deepEqual(
				added,
				place.says?.(refusal)?.filter((line) => !before.includes(line)) ?? [refusalMessage(place.screen, refusal)],
				`${name} ${JSON.stringify(refusal)}`,
			);
			await at.unmount();
		}
	});

test("INV-account-privacy: a sign-up whose first sign-in is refused says nothing about the account beyond refusalMessage", async () => {
	for (const { refusal, reply } of ANSWERS) {
		server({
			"registration-options": () => Response.json(OPTIONS),
			register: () => Response.json({ status: "continue_identity_proof" }),
			"sign-in/email": reply,
		});
		const at = await mount(RegisterScreen, {});
		await at.submit(ACCOUNT);
		const quiet = ["invalid_credentials", "unauthenticated"].includes(codeOf(refusal) ?? "");
		assert.deepEqual(
			at
				.byTag("DIV")
				.filter((n) => n.getAttribute("role") === "alert")
				.map((n) => n.textContent)
				.filter(Boolean),
			quiet ? [] : [refusalMessage("sign_in", refusal)],
			JSON.stringify(refusal),
		);
		assert.ok(at.lines().includes("Sign in to continue"));
		await at.unmount();
	}
});
