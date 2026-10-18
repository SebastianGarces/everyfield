import type { Metadata } from "next";
import { AccessForm, type FieldSpec, type FormText, type StepSpec } from "@/access/AccessForm";
import { FIELD_MAX, PHASES } from "@/access/contract";
import { FIELD_STEPS, WHO, kindOf, type Who } from "@/access/steps";
import { COPY } from "@/marketing/copy";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { PageHero } from "@/marketing/sections/PageHero";
import { Site } from "@/marketing/Site";

// Copy: shared.access_page in design/marketing-copy.json (task E2, step form WP-097).
const A = COPY.shared.access_page;
// The server accepts only the contract's phase values, so the copy must use the same labels.
if (A.phases.join("|") !== PHASES.join("|")) {
	throw new Error("marketing-copy.json: access_page.phases must equal PHASES in src/access/contract.ts");
}

type Shape = Pick<FieldSpec, "type" | "autoComplete" | "options">;
const SHAPES: Record<string, Shape> = {
	name: { type: "text", autoComplete: "name" },
	email: { type: "email", autoComplete: "email" },
	plant_name: { type: "text", autoComplete: "organization" },
	city: { type: "text", autoComplete: "address-level2" },
	phase: { type: "select", options: PHASES },
	sending: { type: "text" },
	organization: { type: "text", autoComplete: "organization" },
	role: { type: "text", autoComplete: "organization-title" },
	plants: { type: "number" },
	message: { type: "area" },
};
const maxFor = (name: string) => Object.entries(FIELD_MAX).find(([k]) => k === name)?.[1];

function field(name: string, who: Who): FieldSpec {
	const shape = SHAPES[name];
	// A church and a network answer the same organization field under their own label.
	const c = name === "organization" && who !== "planter" ? A.organization[who] : A.fields[name];
	if (!shape || !c) throw new Error(`marketing-copy.json: access_page field "${name}" is missing`);
	const copy = { help: undefined, optional: undefined, placeholder: undefined, prompt: undefined, ...c };
	return {
		...shape,
		name,
		label: copy.label,
		optional: copy.optional,
		help: copy.help,
		placeholder: copy.placeholder,
		prompt: copy.prompt,
		// An optional free-text field has no format to get wrong; its only error is length.
		error: copy.error ?? A.outcomes.invalid.title,
		tooLong: A.errors.too_long.replace("{max}", String(maxFor(name) ?? "")),
	};
}

const S = A.form.steps;
const TITLES: Record<Who, [string, string, string]> = {
	planter: [S.contact, S.plant, S.phase],
	church: [S.contact, S.church, S.more],
	network: [S.contact, S.network, S.more],
};
const paths = Object.fromEntries(
	WHO.map((who) => [
		who,
		FIELD_STEPS[kindOf(who)].map((names, i): StepSpec => ({
			title: TITLES[who][i]!,
			fields: names.map((n) => field(n, who)),
		})),
	]),
) as Record<Who, StepSpec[]>;

const text: FormText = {
	progress: A.form.progress,
	back: A.form.back,
	continue: A.form.continue,
	submit: A.form.submit,
	submitting: A.form.submitting,
	who: A.form.who,
	optionalLabel: A.optional_label,
	privacyNote: A.privacy_note,
	contactEmail: A.contact_email,
	outcomes: A.outcomes,
};

export const metadata: Metadata = pageMetadata(PAGES.access);

export default function Access() {
	const note = A.hero.note ?? COPY.journey.cta.note;
	return (
		<Site path="/access">
			<PageHero eyebrow={A.hero.eyebrow} title={A.hero.headline}>
				<div className="mt-[clamp(24px,3vw,40px)] flex flex-col items-center gap-4">
					<p className="max-w-[58ch] text-mk-lead text-text-2">{A.hero.subhead}</p>
					{note ? <p className="mx-auto max-w-[56ch] text-[14px] text-text-3">{note}</p> : null}
				</div>
			</PageHero>
			<section className="relative pb-section">
				<div className="mx-auto max-w-mk px-page">
					<AccessForm paths={paths} text={text} />
				</div>
			</section>
		</Site>
	);
}
