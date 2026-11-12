import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText } from "../../../packages/contracts/src/communication/html.ts";

test("plainText decodes each entity the sanitizer writes into text", () => {
	assert.equal(plainText("<p>Tom &amp; Ann</p>"), "Tom & Ann");
	assert.equal(plainText("<p>Tom & Ann</p>"), "Tom & Ann");
	assert.equal(plainText("<p>1 &lt; 2</p>"), "1 < 2");
	assert.equal(plainText("<p>3 &gt; 2</p>"), "3 > 2");
	assert.equal(plainText("<p>Say &quot;hi&quot;</p>"), 'Say "hi"');
	assert.equal(plainText("<p>Ann&#39;s house</p>"), "Ann's house");
	assert.equal(plainText("<p>Food&nbsp;&amp;&nbsp;fellowship</p>"), "Food & fellowship");
});

test("plainText decodes &amp; last, so double-encoded text stays literal", () => {
	assert.equal(plainText("<p>&amp;lt;b&amp;gt; and &amp;amp;</p>"), "&lt;b&gt; and &amp;");
	// A tag typed as text reads as its characters and is not stripped as markup.
	assert.equal(plainText("<p>&lt;b&gt;bold&lt;/b&gt;</p>"), "<b>bold</b>");
});

test("plainText keeps a link as its decoded label and its URL", () => {
	assert.equal(
		plainText('<p>See <a href="https://example.org/?a=1&amp;b=2">Tom &amp; Ann</a> soon</p>'),
		"See Tom & Ann https://example.org/?a=1&b=2 soon",
	);
	assert.equal(
		plainText('<p><a href="https://example.org/?a=1&amp;b=2">https://example.org/?a=1&amp;b=2</a></p>'),
		"https://example.org/?a=1&b=2",
	);
	// The URL is decoded once, as before: an encoded entity inside it stays encoded.
	assert.equal(plainText('<p><a href="https://example.org/?q=&amp;lt;">go</a></p>'), "go https://example.org/?q=&lt;");
});
