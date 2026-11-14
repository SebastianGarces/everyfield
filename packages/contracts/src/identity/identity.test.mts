import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DASHBOARD_HOME,
	invalidSessionReturn,
	landingFor,
	safeReturn,
	seatMutationResult,
} from "@everyfield/contracts/identity";

test("INV-identity: safe navigation rejects authority changes and expired-session recovery loops", () => {
	assert.equal(safeReturn("/people?sort=name&filter=active"), "/people?sort=name&filter=active");
	assert.equal(safeReturn("/people?name=New%20York&progress=100%25"), "/people?name=New%20York&progress=100%25");
	assert.equal(invalidSessionReturn("/people?sort=name"), "/signin?returnTo=%2Fpeople%3Fsort%3Dname");
	assert.equal(invalidSessionReturn("/signin?returnTo=/people"), "/signin");
	for (const value of [
		null,
		"",
		"https://evil.test",
		"//evil.test",
		"/\\evil.test",
		"/%5cevil.test",
		"/%252f%252fevil.test",
		"/a/..//evil.test",
		"/path\nnext",
		"/%0d%0aLocation:evil",
		// INV-boundary: double-encoded backslash and newline stay refused.
		"/%255cforeign",
		"/%250aheader",
	]) {
		assert.equal(safeReturn(value), null, String(value));
	}
	for (const value of ["/login", "/recover-password?proof=x", "https://evil.test"])
		assert.equal(invalidSessionReturn(value), "/signin");
});

test("AC:TARGET-IDN-028 AC:CASE-ADM-004 landingFor sends a finished seat to a safe returnTo, else its home, and setup never skips", () => {
	assert.equal(DASHBOARD_HOME, "/overview");
	const done = { status: "active", plant: "complete" } as const;
	assert.equal(landingFor({ ...done, returnTo: "/settings/sharing" }), "/settings/sharing");
	assert.equal(landingFor({ ...done, returnTo: "/documents" }), "/documents");
	assert.equal(landingFor({ status: "active", plant: "none", returnTo: "/documents" }), "/documents");
	assert.equal(landingFor({ status: "pending_domain", plant: "none" }), "/onboarding");
	assert.equal(landingFor({ status: "active", plant: "incomplete" }), "/onboarding");
	assert.equal(landingFor({ status: "active", plant: "none" }), "/onboarding");
	assert.equal(landingFor(done), "/overview");
	// An unfinished church or account goes back to setup whatever the address asks for (ADM-004).
	for (const returnTo of ["/overview", "/overview?setup=done", "/people", "/home"]) {
		assert.equal(landingFor({ status: "active", plant: "incomplete", returnTo }), "/onboarding", returnTo);
		assert.equal(landingFor({ status: "pending_domain", plant: "none", returnTo }), "/onboarding", returnTo);
	}
	// An organization seat lands on its plants, not on church setup (WP-047a); a returnTo still wins.
	assert.equal(landingFor({ status: "active", plant: "organization" }), "/network");
	assert.equal(landingFor({ status: "active", plant: "organization", returnTo: "/notifications" }), "/notifications");
	assert.equal(landingFor({ ...done, returnTo: null }), "/overview");
	for (const returnTo of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
		assert.equal(landingFor({ ...done, returnTo }), "/overview", returnTo);
		assert.equal(landingFor({ status: "active", plant: "incomplete", returnTo }), "/onboarding", returnTo);
		assert.equal(landingFor({ status: "pending_domain", plant: "none", returnTo }), "/onboarding", returnTo);
	}
});

test("BUG-PR551: a seat change that leaves a duty remaining is partial, never changed", () => {
	const result = (outcome: string, status: string) => ({
		seatId: "0b6c3f1e-2a7d-4c3b-9f5e-1d2c3b4a5f60",
		revision: "4",
		outcome,
		duties: [{ status, dutyId: "1c7d4f2a-3b8e-4d4c-8a6f-2e3d4c5b6a71" }],
	});
	assert.equal(seatMutationResult.safeParse(result("changed", "remaining")).success, false);
	assert.equal(seatMutationResult.safeParse(result("noop", "remaining")).success, false);
	assert.equal(seatMutationResult.safeParse(result("partial", "remaining")).success, true);
	assert.equal(seatMutationResult.safeParse(result("changed", "needs_owner")).success, true);
});
