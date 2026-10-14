import type { Metadata } from "next";
import { AccessForm, type FieldSpec, type FormMessages } from "@/access/AccessForm";
import { PHASES } from "@/access/contract";
import { COPY, type FormCopy } from "@/marketing/copy";
import { hero } from "@/marketing/markup";
import { Html, Site } from "@/marketing/Site";

// Copy: shared.access_page in design/marketing-copy.json (task E2). Every key falls back to the prototype text.
const A = COPY.shared.access_page ?? {};
const J = COPY.journey, O = COPY.oversight;

const DEFAULT_MESSAGES: FormMessages = {
  received_title: "Thank you. We have your request.",
  received_body: "We read every request and will reply by email.",
  invalid: "Some fields need a change. Check the messages above.",
  unavailable: "Your request was not sent because of a problem on our side. Try again in a few minutes, or email sebastian@everyfield.app.",
  sending: "Sending…",
  required: "This field is required.",
  email: "Enter an email address, like name@church.org.",
  number: "Enter a whole number, like 3.",
  too_long: "This is too long. Shorten it and try again.",
};
const messages: FormMessages = { ...DEFAULT_MESSAGES, ...A.messages };

function fieldsFor(spec: Omit<FieldSpec, "label">[], labels: Record<string, string>, copy?: FormCopy): FieldSpec[] {
  return spec.map((f) => ({ ...f, label: copy?.fields?.[f.name] ?? labels[f.name]! }));
}
const P = A.planter_form, N = A.network_form;
const planterFields = fieldsFor(
  [
    { name: "name", type: "text", autoComplete: "name" },
    { name: "email", type: "email", autoComplete: "email" },
    { name: "plant_name", type: "text", autoComplete: "organization" },
    { name: "city", type: "text", autoComplete: "address-level2" },
    { name: "phase", type: "select", options: P?.phases ?? PHASES },
    { name: "sending", type: "text", optional: true },
  ],
  { name: "Your name", email: "Email", plant_name: "Church plant name", city: "City", phase: "Phase", sending: "Sending church or network" },
  P,
);
const networkFields = fieldsFor(
  [
    { name: "name", type: "text", autoComplete: "name" },
    { name: "email", type: "email", autoComplete: "email" },
    { name: "organization", type: "text", autoComplete: "organization" },
    { name: "role", type: "text", autoComplete: "organization-title" },
    { name: "plants", type: "number", optional: true },
    { name: "message", type: "area", optional: true },
  ],
  { name: "Your name", email: "Email", organization: "Network or church", role: "Your role", plants: "Plants you send or support", message: "What would you like to talk about?" },
  N,
);

const heroCopy = {
  eyebrow: A.hero?.eyebrow ?? "Early access",
  headline: A.hero?.headline ?? COPY.shared.nav_cta,
  subhead: A.hero?.subhead ?? J.cta.body,
  cta_primary: "Request early access",
  cta_secondary: "Talk to us about your network",
  note: A.hero?.note ?? J.cta.note,
};

export const metadata: Metadata = {
  title: "Request early access",
  description: heroCopy.subhead,
  alternates: { canonical: "/access" },
};

export default function Access() {
  const planter = J.audiences.items[0]!;
  return (
    <Site path="/access">
      <Html html={hero(heroCopy, { page: true, visual: false })} />
      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap forms">
          <AccessForm
            kind="planter"
            id="planter-form"
            eyebrow={P?.eyebrow ?? planter.label}
            headline={P?.headline ?? planter.headline}
            body={P?.body ?? planter.body}
            submit={P?.submit ?? J.cta.cta_primary}
            fields={planterFields}
            messages={messages}
          />
          <AccessForm
            kind="network"
            id="network-form"
            eyebrow={N?.eyebrow ?? "For networks and sending churches"}
            headline={N?.headline ?? O.cta.headline}
            body={N?.body ?? O.cta.body}
            submit={N?.submit ?? O.cta.cta_primary}
            fields={networkFields}
            messages={messages}
          />
        </div>
      </section>
    </Site>
  );
}
