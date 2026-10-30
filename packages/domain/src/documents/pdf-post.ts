import { PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";

/** Tooltip text for a field name. Names follow the layout files: `team_task_n`, `present_n` and plain keys. */
const KNOWN: Record<string, string> = {
	full_name: "Full name",
	contact: "Email address or phone number",
	email: "Email address",
	phone: "Phone number",
	signature: "Signature: sign here",
	signed_date: "Date signed",
	commit_grow: "Check to commit to GROW",
	commit_pray: "Check to commit to PRAY",
	commit_give: "Check to commit to GIVE",
	involve_updates: "Check to receive news about the church plant",
	involve_group: "Check to be invited to a weekly group",
	involve_serve: "Check to serve on a launch team",
	involve_pray: "Check to join the prayer list",
	meeting_date: "Meeting date",
	meeting_number: "Meeting number",
	launch_date: "Launch Sunday date",
	meeting_time: "Meeting time",
	meeting_place: "Meeting place",
	facilitator: "Facilitator",
	pastor_name: "Pastor name",
	agreement_signature: "Signature: sign here",
	agreement_date: "Date signed",
};
const INDEXED: Record<string, string> = {
	present: "Check if present: attendee",
	done: "Check when done: action",
	lead: "Lead for segment",
	time: "Start time for segment",
	action: "Action",
	owner: "Owner of action",
	due: "Due date of action",
};
export function tooltipFor(name: string) {
	const known = KNOWN[name];
	if (known) return known;
	const row = /^(.+)_(\d+)_(\w+)$/.exec(name);
	if (row) return `${title(row[1]!)} ${row[2]}: ${title(row[3]!).toLowerCase()}`;
	const n = /^(.+)_(\d+)$/.exec(name);
	if (n) return `${INDEXED[n[1]!] ?? title(n[1]!)} ${n[2]}`.replace(/ (\d+)$/, (_, d) => ` ${d}`);
	return title(name);
}
const title = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Names that become signature fields (/FT /Sig): every place a person signs. */
const isSignature = (name: string) => name === "signature" || name.endsWith("_signature");

/**
 * Forme 0.29 has no tooltip prop and no signature field. After layout, each widget gets /TU, each signature
 * name becomes a /Sig field, and the AcroForm gets a /DR font entry that points at the embedded DM Sans.
 * `updateMetadata: false` keeps the creation and modification dates out, so the bytes stay deterministic.
 */
export async function finishForm(pdf: Uint8Array) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	const form = doc.getForm();
	const fields: { name: string; type: "Sig" | "Tx" | "Btn"; tooltip: string }[] = [];
	for (const field of form.getFields()) {
		const name = field.getName();
		const tooltip = tooltipFor(name);
		const dict = field.acroField.dict;
		dict.set(PDFName.of("TU"), PDFString.of(tooltip));
		const sig = isSignature(name);
		if (sig) {
			dict.set(PDFName.of("FT"), PDFName.of("Sig"));
			for (const key of ["DA", "Ff", "Q", "V"]) dict.delete(PDFName.of(key));
			for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of("DA"));
		}
		fields.push({ name, type: sig ? "Sig" : field.constructor.name === "PDFCheckBox" ? "Btn" : "Tx", tooltip });
	}
	const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
	if (acro instanceof PDFDict) {
		const font = embeddedBodyFont(doc);
		if (font) {
			const fonts = doc.context.obj({ Helv: font });
			acro.set(PDFName.of("DR"), doc.context.obj({ Font: fonts }));
		}
		if (fields.some((f) => f.type === "Sig")) acro.set(PDFName.of("SigFlags"), doc.context.obj(1));
	}
	return {
		bytes: await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }),
		fields,
	};
}

/** The first embedded DM Sans font object in the page resources. */
function embeddedBodyFont(doc: PDFDocument): PDFRef | null {
	for (const page of doc.getPages()) {
		const resources = page.node.Resources();
		const fonts = resources?.lookup(PDFName.of("Font"));
		if (!(fonts instanceof PDFDict)) continue;
		for (const [, value] of fonts.entries()) {
			if (!(value instanceof PDFRef)) continue;
			const font = doc.context.lookup(value);
			const base = font instanceof PDFDict ? font.get(PDFName.of("BaseFont")) : undefined;
			if (base instanceof PDFName && base.decodeText().includes("DMSans")) return value;
		}
	}
	return null;
}
