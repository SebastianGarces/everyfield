import type { Metadata } from "next";
import { AccessForm, type FieldSpec, type FormText } from "@/access/AccessForm";
import { FIELD_MAX, PHASES } from "@/access/contract";
import { COPY, type FormCopy } from "@/marketing/copy";
import { hero } from "@/marketing/markup";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { Html, Site } from "@/marketing/Site";

// Copy: shared.access_page in design/marketing-copy.json (task E2).
const A = COPY.shared.access_page;
// The server accepts only the contract's phase values, so the copy must use the same labels.
if (A.planter_form.phases && A.planter_form.phases.join("|") !== PHASES.join("|")) {
  throw new Error("marketing-copy.json: access_page.planter_form.phases must equal PHASES in src/access/contract.ts");
}

type Shape = Pick<FieldSpec, "name" | "type" | "autoComplete" | "options">;
const maxFor = (name: string) => Object.entries(FIELD_MAX).find(([k]) => k === name)?.[1];
function fieldsFor(shapes: Shape[], copy: FormCopy): FieldSpec[] {
  return shapes.map((s) => {
    const c = copy.fields[s.name];
    if (!c) throw new Error(`marketing-copy.json: access_page form field "${s.name}" is missing`);
    return {
      ...s,
      label: c.label,
      optional: c.optional,
      help: c.help,
      placeholder: c.placeholder,
      prompt: c.prompt,
      // An optional free-text field has no format to get wrong; its only error is length.
      error: c.error ?? A.outcomes.invalid.title,
      tooLong: A.errors.too_long.replace("{max}", String(maxFor(s.name) ?? "")),
    };
  });
}
const text = (f: FormCopy): FormText => ({
  eyebrow: f.eyebrow,
  headline: f.headline,
  body: f.body,
  submit: f.submit,
  submitting: f.submitting,
  optionalLabel: A.optional_label,
  privacyNote: A.privacy_note,
  contactEmail: A.contact_email,
  outcomes: A.outcomes,
});

const planterFields = fieldsFor(
  [
    { name: "name", type: "text", autoComplete: "name" },
    { name: "email", type: "email", autoComplete: "email" },
    { name: "plant_name", type: "text", autoComplete: "organization" },
    { name: "city", type: "text", autoComplete: "address-level2" },
    { name: "phase", type: "select", options: PHASES },
    { name: "sending", type: "text" },
  ],
  A.planter_form,
);
const networkFields = fieldsFor(
  [
    { name: "name", type: "text", autoComplete: "name" },
    { name: "email", type: "email", autoComplete: "email" },
    { name: "organization", type: "text", autoComplete: "organization" },
    { name: "role", type: "text", autoComplete: "organization-title" },
    { name: "plants", type: "number" },
    { name: "message", type: "area" },
  ],
  A.network_form,
);

export const metadata: Metadata = pageMetadata(PAGES.access);

export default function Access() {
  const heroCopy = { ...A.hero, cta_primary: "Request early access", cta_secondary: "Talk to us about your network", note: A.hero.note ?? COPY.journey.cta.note };
  return (
    <Site path="/access">
      <Html html={hero(heroCopy, { page: true, visual: false })} />
      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap forms">
          <AccessForm kind="planter" id="planter-form" fields={planterFields} text={text(A.planter_form)} />
          <AccessForm kind="network" id="network-form" fields={networkFields} text={text(A.network_form)} />
        </div>
      </section>
    </Site>
  );
}
