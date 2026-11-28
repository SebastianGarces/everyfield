---
name: policy-writing
description: Use before writing or changing any privacy policy, terms or other public legal text, including the privacy_page and terms_page copy in design/marketing-copy.json and requirements that say what that text must state. Keeps the text general, in categories, and sends the final wording to Maya.
---

# Policy writing

Public legal text stays general. Say what kind of provider, data or safeguard is involved, and stop there.

## Rules

1. Name categories of providers, data and safeguards: "our hosting provider", "our cloud database provider", "our cloud
   storage provider", "our email provider", "request logs", "encrypted backups".
2. Never name a vendor, hosting product, region, internal setup or implementation detail. A country is fine where the
   text must say where data is kept.
3. No outage or failure scenario unless Sebastian approves that exact line. Recovery limits belong in the internal docs.
4. Make a commitment only where one must be stated, because the law or a requirement asks for it. Word it generally:
   "removed from our backups as they roll over on a regular schedule".
5. No exact timeframe unless the law requires one or Sebastian asks for it. "Once we no longer need them for that"
   instead of a number of days.
6. Write "Everyfield" with a lowercase f, and "church plant", never a bare "plant".

General does not mean false. Every line must still be true of the product, and no limit the product has goes away.

## Where the text lives

- Live source: `shared.privacy_page` and `shared.terms_page` in `design/marketing-copy.json`. The pages in
  `apps/web/src/app/privacy/` and `apps/web/src/app/terms/` only render it.
- Prototype copy: the same keys in `design/everyfield-marketing.html`. Give each line it already has the same wording.
- What the text must say: REQ-ADM-006, REQ-ADM-007 and REQ-KNOW-074 in `docs/catalog/requirements/`. A requirement or
  case that asks the public text for a specific this skill forbids is wrong: reword it to the category.

## Steps

1. Read these rules and the current text.
2. Edit the live source and the prototype copy. Change the page's `updated` date to the day of the final edit in both.
3. Run `node --conditions=react-server --test tests/unit/marketing/legal-copy.test.mjs`. It refuses the obvious breaches.
   A timeframe or outage line the law requires or Sebastian approved goes in its allow list, as the exact line with the
   reason, for example "Sebastian approved v3 verbatim, Nov 28, 2026 (D-3110)". The test cannot judge
   tone or internal detail, so read every changed line against the rules yourself.
4. Take 390 and 1440 px screenshots of the page.
5. Put the complete final text in your summary. Maya owns the copy and OKs the final wording before landing.
