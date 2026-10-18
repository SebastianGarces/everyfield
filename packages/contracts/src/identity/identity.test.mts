import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  changePasswordRequest, classifyPublicPreview, credentialOutcome, identityError,
  identityPurgeStatus, invalidSessionReturn, passwordRecoveryRequest, passwordRecoveryResult,
  recoverPasswordRequest, recoveryCompletedResult, registrationRequest, registrationResult,
  registrationStatus, retainedAttribution, retainedHistoryReference, resumeRegistrationRequest,
  safeReturn, sessionResult, signInRequest, selfSessionRequest,
} from "@everyfield/contracts/identity";

const account = "10000000-0000-4000-8000-000000000001";
const tenant = "20000000-0000-4000-8000-000000000001";
const operation = "30000000-0000-4000-8000-000000000001";
const correlation = "40000000-0000-4000-8000-000000000001";
const input = { email: "  ALEX@Example.test ", password: "  pass  word  ", name: " Alex ", requestKey: "register-1" };
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));

test("INV-identity: registration boundary normalizes identity and admits only the advertised invitation context", () => {
  assert.deepEqual(wire(registrationRequest, { ...input, kind: "plant_precreation" }), {
    email: "alex@example.test", password: "  pass  word  ", name: "Alex", requestKey: "register-1", kind: "plant_precreation",
  });
  for (const kind of ["sending_church", "sending_network"]) {
    assert.equal(wire(registrationRequest, { ...input, kind, organizationName: " Grace " }).kind, kind);
    assert.throws(() => wire(registrationRequest, { ...input, kind }), z.ZodError);
  }
  assert.equal(wire(registrationRequest, { ...input, kind: "discovery" }).kind, "discovery");
  const invited = { ...input, kind: "invitation", invitationProof: "native-proof" };
  assert.equal(wire(registrationRequest, invited).kind, "invitation");
  for (const extra of [{ role: "owner" }, { accountId: account }, { tenantId: tenant }, { kind: "owner" }]) {
    assert.throws(() => wire(registrationRequest, { ...invited, ...extra }), z.ZodError);
  }
  assert.deepEqual(wire(resumeRegistrationRequest, { requestKey: "register-1" }), { requestKey: "register-1" });
  assert.throws(() => wire(resumeRegistrationRequest, { requestKey: "register-1", email: input.email, accountId: account }), z.ZodError);
});

test("INV-identity: native secret confirmation cannot choose the reset subject or session revocation policy", () => {
  const reset = { proof: "native-reset", newPassword: "different-secret", confirmPassword: "different-secret" };
  assert.deepEqual(wire(recoverPasswordRequest, reset), reset);
  assert.deepEqual(wire(changePasswordRequest, { currentPassword: "old", newPassword: reset.newPassword, confirmPassword: reset.confirmPassword }), {
    currentPassword: "old", newPassword: "different-secret", confirmPassword: "different-secret",
  });
  for (const extra of [{ accountId: account }, { revokeSessionsOnPasswordReset: false }, { confirmPassword: "wrong-secret" }]) {
    assert.throws(() => wire(recoverPasswordRequest, { ...reset, ...extra }), z.ZodError);
  }
  for (const length of [8, 1024]) assert.equal(recoverPasswordRequest.parse({ ...reset, newPassword: "x".repeat(length), confirmPassword: "x".repeat(length) }).newPassword.length, length);
  for (const length of [7, 1025]) assert.throws(() => recoverPasswordRequest.parse({ ...reset, newPassword: "x".repeat(length), confirmPassword: "x".repeat(length) }), z.ZodError);
  assert.deepEqual(wire(passwordRecoveryRequest, { email: input.email }), { email: "alex@example.test" });
  assert.deepEqual(wire(signInRequest, { email: input.email, password: " x " }), { email: "alex@example.test", password: " x " });
  assert.deepEqual(wire(signInRequest, { email: input.email, password: " x ", returnTo: "//evil.test" }), { email: "alex@example.test", password: " x ", returnTo: null });
  assert.deepEqual(wire(signInRequest, { email: input.email, password: " x ", returnTo: "/people?sort=name" }), { email: "alex@example.test", password: " x ", returnTo: "/people?sort=name" });
  assert.deepEqual(wire(passwordRecoveryResult, { status: "accepted" }), { status: "accepted" });
  assert.throws(() => wire(passwordRecoveryResult, { status: "accepted", accountExists: true }), z.ZodError);
  assert.deepEqual(wire(recoveryCompletedResult, { status: "password_reset", next: "sign_in" }), { status: "password_reset", next: "sign_in" });
  assert.throws(() => wire(recoveryCompletedResult, { status: "password_reset", next: "sign_in", sessionId: "auto-login" }), z.ZodError);
});

test("INV-identity: pending native identity has bounded self status without grant or provider data", () => {
  const pending = { status: "pending_domain", accountId: account };
  assert.deepEqual(wire(registrationStatus, pending), pending);
  assert.deepEqual(wire(registrationResult, pending), pending);
  assert.deepEqual(wire(registrationResult, { status: "active", accountId: account, operationId: operation }), { status: "active", accountId: account, operationId: operation });
  const session = { ...pending, sessionId: "live-session", expiresAt: "2026-11-18T12:00:00.000Z" };
  assert.deepEqual(wire(sessionResult, session), session);
  assert.deepEqual(wire(sessionResult, { status: "unauthenticated" }), { status: "unauthenticated" });
  for (const extra of [{ role: "owner" }, { tenantId: tenant }, { cookie: "private" }, { token: "private" }]) {
    assert.throws(() => wire(sessionResult, { ...session, ...extra }), z.ZodError);
  }
  assert.throws(() => wire(registrationResult, { status: "active", accountId: account }), z.ZodError);
  assert.deepEqual(wire(selfSessionRequest, {}), {});
  assert.throws(() => wire(selfSessionRequest, { sessionId: "foreign" }), z.ZodError);
});

test("INV-identity: a committed credential outcome survives reporting failure without durable secret replay", () => {
  const succeeded = { status: "succeeded", accountId: account, correlationId: correlation, action: "password_reset", reporting: { status: "pending_investigation" } };
  assert.deepEqual(wire(credentialOutcome, succeeded), succeeded);
  assert.deepEqual(wire(credentialOutcome, { ...succeeded, reporting: { status: "recorded", eventId: operation, mailIntentId: tenant } }), { ...succeeded, reporting: { status: "recorded", eventId: operation, mailIntentId: tenant } });
  for (const status of ["unknown", "refused"]) {
    assert.deepEqual(wire(credentialOutcome, { status, correlationId: correlation }), { status, correlationId: correlation });
    assert.throws(() => wire(credentialOutcome, { ...succeeded, status }), z.ZodError);
  }
  for (const field of ["password", "proof", "token", "cookie", "retryPassword"]) {
    assert.throws(() => wire(credentialOutcome, { ...succeeded, [field]: "private" }), z.ZodError);
  }
  const error = { code: "invalid_credentials", details: {}, correlationId: correlation, retry: "never" };
  assert.deepEqual(wire(identityError, error), error);
  assert.throws(() => wire(identityError, { ...error, details: { accountExists: true } }), z.ZodError);
});

test("AC:WP005-KNOW-069 retained attribution boundary preserves explicit church ownership without credential leakage", () => {
  assert.deepEqual(wire(retainedAttribution, { kind: "removed_account" }), { kind: "removed_account" });
  const shared = { owner: { kind: "plant", id: tenant }, attribution: { kind: "removed_account" } };
  assert.deepEqual(wire(retainedHistoryReference, shared), shared);
  assert.deepEqual(wire(retainedHistoryReference, { ...shared, owner: { kind: "organization", id: tenant } }), { ...shared, owner: { kind: "organization", id: tenant } });
  assert.throws(() => wire(retainedHistoryReference, { ...shared, owner: { kind: "account", id: account } }), z.ZodError);
  assert.throws(() => wire(retainedHistoryReference, { ...shared, creator: account }), z.ZodError);
  for (const extra of [{ email: "private@example.test" }, { password: "private" }, { accountId: account }]) {
    assert.throws(() => wire(retainedAttribution, { kind: "removed_account", ...extra }), z.ZodError);
  }
});

test("AC:WP005-KNOW-072 purge-status boundary refuses incomplete completion and extended copy expiry", () => {
  assert.deepEqual(wire(identityPurgeStatus, { status: "purging" }), { status: "purging" });
  const completed = { status: "purged", livePurgedAt: "2026-11-18T12:00:00.000Z", copyExpiresAt: "2026-11-25T12:00:00.000Z" };
  assert.deepEqual(wire(identityPurgeStatus, completed), completed);
  assert.throws(() => wire(identityPurgeStatus, { status: "purging", livePurgedAt: completed.livePurgedAt }), z.ZodError);
  assert.throws(() => wire(identityPurgeStatus, { status: "purged" }), z.ZodError);
  for (const copyExpiresAt of ["2026-11-25T12:00:00.000001Z", "2026-11-25T12:00:00.001Z", "2026-11-18T11:59:59Z"]) {
    assert.throws(() => wire(identityPurgeStatus, { ...completed, copyExpiresAt }), z.ZodError);
  }
});

test("INV-identity: safe navigation rejects authority changes and expired-session recovery loops", () => {
  assert.equal(safeReturn("/people?sort=name&filter=active"), "/people?sort=name&filter=active");
  assert.equal(safeReturn("/people?name=New%20York&progress=100%25"), "/people?name=New%20York&progress=100%25");
  assert.equal(invalidSessionReturn("/people?sort=name"), "/signin?returnTo=%2Fpeople%3Fsort%3Dname");
  assert.equal(invalidSessionReturn("/signin?returnTo=/people"), "/signin");
  for (const value of [null, "", "https://evil.test", "//evil.test", "/\\evil.test", "/%5cevil.test", "/%252f%252fevil.test", "/a/..//evil.test", "/path\nnext", "/%0d%0aLocation:evil"]) {
    assert.equal(safeReturn(value), null, String(value));
  }
  for (const value of ["/login", "/recover-password?proof=x", "https://evil.test"]) assert.equal(invalidSessionReturn(value), "/signin");
});

test("INV-identity: preview classification accepts only actual Wiki fetchers and never private paths or human WebViews", () => {
  assert.deepEqual(classifyPublicPreview("https://app.example.test/wiki/article?x=1", "Twitterbot/1.0", "GET"), { kind: "public_wiki_metadata" });
  assert.deepEqual(classifyPublicPreview("https://app.example.test/wiki", "Mozilla/5.0 Googlebot/2.1", "GET"), { kind: "public_wiki_metadata" });
  assert.deepEqual(classifyPublicPreview("https://app.example.test/wiki", "Twitterbot/1.0", "POST"), { kind: "ordinary" });
  for (const [url, ua] of [
    ["https://app.example.test/wiki", "unknown"],
    ["https://app.example.test/people", "Twitterbot/1.0"],
    ["https://app.example.test/wikileaks", "Twitterbot/1.0"],
    ["https://app.example.test/wiki", "Mozilla/5.0 AppleWebKit/537.36 WhatsApp/2"],
    ["invalid", "Twitterbot/1.0"],
  ]) assert.deepEqual(classifyPublicPreview(url!, ua!, "GET"), { kind: "ordinary" });
});
