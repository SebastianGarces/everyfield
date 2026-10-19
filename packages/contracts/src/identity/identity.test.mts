import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPublicPreview, invalidSessionReturn, safeReturn } from "@everyfield/contracts/identity";

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
