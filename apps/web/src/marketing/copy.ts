import "server-only";
import { z } from "zod";
import raw from "../../../../design/marketing-copy.json";

// design/marketing-copy.json is the copy authority (task E2 owns it). It is parsed here, at build time,
// so a shape change fails the build instead of rendering a broken page. Only the fields the live pages read are listed.

const text = z.string().min(1);
const step = z.object({ title: text, body: text });
const cta = z.object({ headline: text, body: text, cta_primary: text, cta_secondary: text, note: text.optional() });
const hero = z.object({
  eyebrow: text.optional(),
  headline: text,
  subhead: text,
  cta_primary: text,
  cta_secondary: text.optional(),
  note: text.optional(),
});
const headBody = z.object({ headline: text, body: text });

const journey = z.object({
  id: z.literal("journey"),
  sections: z.object({
    hero,
    problem: headBody,
    proof: headBody.extend({ caption: text.optional() }),
    features: z.object({
      headline: text,
      items: z.array(z.object({ label: text, title: text, body: text, short: text.optional() })),
    }),
    audiences: z.object({ items: z.array(z.object({ label: text, headline: text, body: text })).min(1) }),
    cta,
  }),
});
const oversight = z.object({ id: z.literal("oversight"), sections: z.object({ cta }) });

// Copy that E2 drafts. Every key is optional: a missing key falls back to the prototype text.
const formCopy = z.object({
  eyebrow: text.optional(),
  headline: text.optional(),
  body: text.optional(),
  submit: text.optional(),
  fields: z.record(z.string(), text).optional(),
  phases: z.array(text).length(7).optional(),
});
const accessPage = z.object({
  hero: z
    .object({ eyebrow: text.optional(), headline: text.optional(), subhead: text.optional(), note: text.optional() })
    .optional(),
  planter_form: formCopy.optional(),
  network_form: formCopy.optional(),
  messages: z.record(z.string(), text).optional(),
});
const legalPage = z.object({
  title: text.optional(),
  updated: text.optional(),
  intro: text.optional(),
  sections: z
    .array(z.object({ heading: text, paragraphs: z.array(text).optional(), items: z.array(text).optional() }))
    .optional(),
});

const schema = z.object({
  shared: z.object({
    nav: z.array(z.object({ label: text })),
    nav_cta: text,
    footer: z.object({
      headline: text,
      cta: text,
      columns: z.array(z.object({ title: text, links: z.array(text) })),
      fineprint: text,
    }),
    week: z.object({
      title: text,
      steps: z.array(step.extend({ panel: text, tone: text, icon: text })).length(4),
    }),
    intelligence: z.object({ title: text }),
    sending: z.object({ title: text, link: text, steps: z.array(step).length(4) }),
    oversight_page: z.object({
      hero,
      problem: headBody,
      chapter: z.object({ title: text, steps: z.array(step.extend({ panel: text })).length(4) }),
      intelligence: z.object({ title: text, steps: z.array(step).length(4) }),
      plants: z.object({
        headline: text,
        items: z.array(z.object({ label: text, title: text, body: text.optional(), short: text.optional() })).length(6),
      }),
      paths: z.object({
        lead: text,
        tail: text,
        line: text,
        states: z.array(z.object({ phrase: text, title: text, body: text })).length(3),
      }),
      faq: z.object({
        headline: text,
        items: z.array(z.object({ id: text, q: text, a: text, link: text.optional() })),
      }),
      cta,
    }),
    access_page: accessPage.optional(),
    privacy_page: legalPage.optional(),
    terms_page: legalPage.optional(),
  }),
  directions: z.tuple([journey, oversight], z.unknown()),
});

// The official brand spelling is EveryField. The copy file sometimes says "Everyfield"; fix it once, here.
const brand = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/Everyfield/g, "EveryField")
  : Array.isArray(v) ? v.map(brand)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brand(x)]))
  : v;

const parsed = schema.parse(brand(raw));

export const COPY = {
  shared: parsed.shared,
  journey: parsed.directions[0].sections,
  oversight: parsed.directions[1].sections,
};
export type Copy = typeof COPY;
export type LegalCopy = z.infer<typeof legalPage>;
export type FormCopy = z.infer<typeof formCopy>;
