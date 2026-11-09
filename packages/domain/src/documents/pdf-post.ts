import {
	BlendMode,
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFOperator,
	PDFOperatorNames,
	PDFRef,
	PDFString,
	rgb,
} from "pdf-lib";
import { PLACEHOLDER_FILL } from "./doc-values.ts";

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
function tooltipFor(name: string) {
	const known = KNOWN[name];
	if (known) return known;
	const adopt = /^adopt_(\d+)_(name|role|signature|date)$/.exec(name);
	if (adopt)
		return `Board member ${adopt[1]}: ${{ name: "name", role: "role", signature: "sign here", date: "date signed" }[adopt[2] as "name"]}`;
	const row = /^(.+)_(\d+)_(\w+)$/.exec(name);
	if (row) return `${title(row[1]!)} ${row[2]}: ${title(row[3]!).toLowerCase()}`;
	const n = /^(.+)_(\d+)$/.exec(name);
	if (n) return `${INDEXED[n[1]!] ?? title(n[1]!)} ${n[2]}`;
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
export async function finishForm(pdf: Uint8Array, highlights: readonly Highlight[] = []) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	paintHighlights(doc, highlights);
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
	linkWidgetsToForms(doc);
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

/** A box to highlight: a 0-based page, then x and y from the top-left corner, in points. */
export type Highlight = { page: number; x: number; y: number; width: number; height: number };

/**
 * Forme 0.29 paints no background behind a text run, so a placeholder highlight is painted after layout: a fill over
 * each box in multiply blend, so the text under it stays as dark as it was and the paper turns the fill's color. Each
 * fill is marked as an artifact, so a screen reader and the tag tree skip it.
 */
function paintHighlights(doc: PDFDocument, highlights: readonly Highlight[]) {
	const pages = doc.getPages();
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(PLACEHOLDER_FILL.slice(i, i + 2), 16) / 255) as [
		number,
		number,
		number,
	];
	for (const box of highlights) {
		const page = pages[box.page];
		if (!page) continue;
		page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of("Artifact")]));
		page.drawRectangle({
			x: box.x - 0.5,
			y: page.getHeight() - box.y - box.height,
			width: box.width,
			height: box.height,
			color: rgb(r, g, b),
			blendMode: BlendMode.Multiply,
		});
		page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
	}
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

/**
 * PDF/UA 7.18.4: a Form tag holds one object reference to its widget annotation. Forme 0.29 tags each field as a
 * Form element over marked content and leaves the widget unlinked. Both lists are in reading order, so the n-th
 * Form element and the n-th widget pair up; the pass does nothing when the counts differ.
 */
function linkWidgetsToForms(doc: PDFDocument) {
	const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"));
	if (!(root instanceof PDFDict)) return;
	const forms: { ref: PDFRef; dict: PDFDict }[] = [];
	const walk = (node: unknown) => {
		if (node instanceof PDFRef) {
			const target = doc.context.lookup(node);
			if (target instanceof PDFDict && target.get(PDFName.of("S")) === PDFName.of("Form"))
				forms.push({ ref: node, dict: target });
			else walk(target);
		} else if (node instanceof PDFDict) walk(node.get(PDFName.of("K")));
		else if (node instanceof PDFArray) for (const child of node.asArray()) walk(child);
	};
	walk(root.get(PDFName.of("K")));
	const widgets: { ref: PDFRef; page: PDFRef; dict: PDFDict }[] = [];
	for (const page of doc.getPages()) {
		const annots = page.node.Annots();
		if (!annots) continue;
		for (const ref of annots.asArray()) {
			const dict = doc.context.lookup(ref);
			if (dict instanceof PDFDict && dict.get(PDFName.of("Subtype")) === PDFName.of("Widget")) {
				widgets.push({ ref: ref as PDFRef, page: page.ref, dict });
			}
		}
	}
	const tree = root.lookup(PDFName.of("ParentTree"));
	const nums = tree instanceof PDFDict ? tree.lookup(PDFName.of("Nums")) : undefined;
	if (forms.length === 0 || forms.length !== widgets.length || !(nums instanceof PDFArray)) return;
	let key = 0;
	for (let i = 0; i < nums.size(); i += 2) key = Math.max(key, (nums.lookup(i, PDFNumber) as PDFNumber).asNumber() + 1);
	forms.forEach((form, i) => {
		const widget = widgets[i]!;
		const objr = doc.context.obj({ Type: "OBJR", Obj: widget.ref, Pg: widget.page });
		form.dict.set(PDFName.of("K"), doc.context.obj([objr]));
		widget.dict.set(PDFName.of("StructParent"), PDFNumber.of(key));
		nums.push(PDFNumber.of(key));
		nums.push(form.ref);
		key += 1;
	});
}
