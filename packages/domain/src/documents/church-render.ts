import type { ChurchBlock } from "@everyfield/contracts/documents";
import { buildDocx } from "./docx.ts";
import type { ExportTheme } from "./church-theme.ts";
import { churchDocument } from "./layouts/church-doc.tsx";
import { RenderFailed, renderContext, renderPdfElement, unsafe } from "./render.ts";
import type { ChurchTemplate } from "./templates/church.ts";

export type ChurchRender = {
	template: ChurchTemplate;
	body: readonly ChurchBlock[];
	/** The church name and pastor name frozen into the document when it was made. */
	church: string;
	pastorName: string | null;
	theme: ExportTheme;
	/** When the revision was saved. Word keeps it as the file's creation time. */
	savedAt: Date;
};

const texts = (body: readonly ChurchBlock[]) => body.flatMap((b) => ("items" in b ? b.items : [b.text]));

function check(input: ChurchRender) {
	if ([input.church, input.pastorName ?? "", ...texts(input.body)].some(unsafe)) throw new RenderFailed();
}

/** The PDF of one revision: Forme with PDF/UA tags, through the same render path as the template preview. */
export async function renderChurchPdf(input: ChurchRender) {
	check(input);
	const values: Record<string, string> = { church_name: input.church };
	if (input.pastorName) values.pastor_name = input.pastorName;
	const ctx = renderContext(input.church, values, input.theme.render, input.template.documentClass);
	try {
		return await renderPdfElement(churchDocument(ctx, input.template, input.body));
	} catch (error) {
		if (error instanceof RenderFailed) throw error;
		throw new RenderFailed();
	}
}

/** The Word file of one revision. */
export function renderChurchDocx(input: ChurchRender) {
	check(input);
	try {
		return buildDocx({
			template: input.template,
			body: input.body,
			church: input.church,
			pastorName: input.pastorName,
			theme: input.theme.render,
			fonts: input.theme.fonts,
			created: input.savedAt,
		});
	} catch {
		throw new RenderFailed();
	}
}
