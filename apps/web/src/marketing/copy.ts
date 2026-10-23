import "server-only";
import { z } from "zod";
import raw from "../../../../design/marketing-copy.json";
import { LIVE_PAGES } from "@/site";

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

const railItem = z.object({ label: text, title: text, short: text });
const faqItem = z.object({ id: text, q: text, a: text, link: text.optional() });

const journey = z.object({
	id: z.literal("journey"),
	sections: z.object({
		hero,
		problem: headBody,
		vision: headBody.extend({ bridge: text }),
		features: z.object({ headline: text, items: z.array(railItem).length(6) }),
		evry: z.object({
			headline: text,
			body: text,
			limits: text,
			example: z.object({
				ask: text,
				answer: text,
				review: text.refine((s) => s.split(" · ").length === 3, "review needs three parts"),
			}),
		}),
		cta,
	}),
});

// Copy drafted by task E2 (shared.access_page, privacy_page, terms_page). All three are required:
// a missing or malformed page fails the build, so no placeholder legal page can be published.
const fieldCopy = z.object({
	label: text,
	optional: z.literal(true).optional(),
	help: text.optional(),
	error: text.optional(),
	placeholder: text.optional(),
	prompt: text.optional(),
});
const outcome = z.object({ title: text, body: text, link: text.optional() });
const accessPage = z.object({
	hero: z.object({ eyebrow: text, headline: text, subhead: text, note: text.optional() }),
	contact_email: z.email(),
	form: z.object({
		progress: text.refine((s) => s.includes("{step}") && s.includes("{total}"), "progress needs {step} and {total}"),
		back: text,
		continue: text,
		submit: text,
		submitting: text,
		who: z.object({
			title: text,
			error: text,
			options: z.object({ planter: text, church: text, network: text }),
		}),
		steps: z.object({ contact: text, plant: text, phase: text, church: text, network: text, more: text }),
	}),
	fields: z.record(z.string(), fieldCopy),
	// A church and a network send the same request; only this field's label and error differ.
	organization: z.object({
		church: z.object({ label: text, error: text }),
		network: z.object({ label: text, error: text }),
	}),
	phases: z.array(text).length(7),
	errors: z.object({ too_long: text.refine((s) => s.includes("{max}"), "too_long needs {max}") }),
	optional_label: text,
	privacy_note: z
		.object({ text, link: text })
		.refine((n) => n.text.includes(n.link), "privacy_note.link must appear in privacy_note.text"),
	outcomes: z.object({
		received: outcome,
		invalid: outcome,
		rate_limited_email: outcome,
		rate_limited_ip: outcome,
		unavailable: outcome,
		offline: outcome,
	}),
});
const legalPage = z.object({
	title: text,
	updated: text.optional(),
	intro: z.array(text).optional(),
	sections: z.array(z.object({ heading: text, paragraphs: z.array(text).optional(), items: z.array(text).optional() })),
	links: z.object({ privacy: text.optional() }).optional(),
});

const schema = z.object({
	shared: z.object({
		nav: z.array(z.object({ label: text, href: z.enum(LIVE_PAGES) })),
		nav_cta: text,
		footer: z.object({
			headline: text,
			// / and /oversight use their own footer headline; /access, /privacy and /terms use headline.
			headline_home_oversight: text,
			cta: text,
			columns: z.array(z.object({ title: text, links: z.array(text) })),
			fineprint: text,
		}),
		week: z.object({ title: text, steps: z.array(step.extend({ panel: text, icon: text })).length(4) }),
		intelligence: z.object({ title: text, lead: text, steps: z.array(step.extend({ panel: text })).length(4) }),
		sending: z.object({ title: text, body: text, link: text }),
		// Text that sits inside the product pictures on / and /oversight.
		panels: z.object({
			week_follow_says: text,
			week_people_line: text,
			intelligence_focus_title: text,
			monday_title: text,
			monday_sub: text,
			monday_core_label: text,
			teams_sign_core: text,
			launch_team_member: text,
			ministry_areas: z.array(text).length(8),
			share_unshared_status: text,
			hero_dash_finding: text,
			hero_dash_attention_label: text,
			status_watch: text,
			mueller_plant: text,
		}),
		oversight_page: z.object({
			hero,
			problem: headBody,
			trust: z.object({ headline: text, items: z.array(step).length(4) }),
			chapter: z.object({ title: text, steps: z.array(step.extend({ panel: text })).length(4) }),
			intelligence: z.object({ title: text, steps: z.array(step).length(4) }),
			plants: z.object({ headline: text, items: z.array(railItem).length(6) }),
			leaders: z.object({ headline: text, lead: text, steps: z.array(step).length(4) }),
			paths: z.object({
				lead: text,
				tail: text,
				line: text,
				states: z.array(z.object({ phrase: text, title: text, body: text })).length(3),
			}),
			faq: z.object({ headline: text, items: z.array(faqItem).min(1) }),
			cta,
		}),
		access_page: accessPage,
		privacy_page: legalPage,
		terms_page: legalPage,
	}),
	directions: z.tuple([journey], z.unknown()),
});

const parsed = schema.parse(raw);

export const COPY = {
	shared: parsed.shared,
	journey: parsed.directions[0].sections,
};
export type Copy = typeof COPY;

export type LegalCopy = z.infer<typeof legalPage>;
export type FieldCopy = z.infer<typeof fieldCopy>;
export type AccessCopy = z.infer<typeof accessPage>;
export type Outcome = z.infer<typeof outcome>;
