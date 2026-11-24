import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ORGANIZATION_HOME } from "../../../packages/contracts/src/identity/index.ts";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const log: string[] = [];
const recorded =
	<T,>(name: string, value: T) =>
	async () => {
		log.push(name);
		return value;
	};
let seat: object | null = null;
class Redirected extends Error {}

mock.module(pathToFileURL(web.resolve("next/navigation")).href, {
	namedExports: {
		redirect: (to: string) => {
			log.push(`redirect ${to}`);
			throw new Redirected(to);
		},
	},
});
mock.module(at("server/request-context.ts"), {
	namedExports: {
		getViewer: async () => ({ status: "active", authority: { actor: { context: { kind: "account" } } } }),
		organizationSeatOf: () => seat,
	},
});
mock.module(at("server/sign-in.ts"), { namedExports: { signIn: () => assert.fail("nobody is signed out here") } });
mock.module(at("features/onboarding/mount.ts"), { namedExports: { onboardingEntry: recorded("onboardingEntry", {}) } });
mock.module(at("features/organizations/mount.ts"), {
	namedExports: { ownResidencyLinks: recorded("ownResidencyLinks", []) },
});
mock.module(at("features/onboarding/port.ts"), {
	namedExports: { parseEntry: () => ({ kind: "entry", entry: { kind: "discovery" } }) },
});
mock.module(at("features/onboarding/foundations.ts"), { namedExports: { FOUNDATION_ARTICLES: [] } });
mock.module(at("features/onboarding/model.ts"), {
	namedExports: { parseStep: () => null, initialState: () => ({}), addressStep: () => null },
});
mock.module(at("features/onboarding/RealOnboarding.tsx"), { namedExports: { RealOnboarding: () => null } });
const { OnboardingPage } = await import("../../../apps/web/src/features/onboarding/routes.tsx");
const open = () => {
	log.length = 0;
	return OnboardingPage({ searchParams: Promise.resolve({}) });
};

test("INV-onboarding: an organization seat that opens onboarding goes to the organization home before any onboarding read; a person with no seat stays", async () => {
	seat = { seatId: "s" };
	await assert.rejects(open(), Redirected);
	assert.deepEqual(log, [`redirect ${ORGANIZATION_HOME}`]);

	seat = null;
	await open();
	assert.deepEqual(log, ["onboardingEntry", "ownResidencyLinks"]);
});
