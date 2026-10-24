import "server-only";

export type PdfRenderer = (title: string, body: string) => Uint8Array;

function escapePdf(text: string): string {
	return text
		.replace(/[^\n\x20-\x7e]/g, "?")
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
}

/** One-page PDF that uses the built-in Helvetica font and no network resource. */
export function helveticaPdf(title: string, body: string): Uint8Array {
	const lines = [title, ...body.split(/\n/)].flatMap((line) => {
		const clean = escapePdf(line);
		const chunks: string[] = [];
		for (let i = 0; i < Math.max(clean.length, 1); i += 80) chunks.push(clean.slice(i, i + 80));
		return chunks.length ? chunks : [""];
	});
	const commands = ["BT", "/F1 11 Tf", "72 760 Td", "14 TL"];
	lines.forEach((line, index) => {
		commands.push(index === 0 ? `(${line}) Tj` : `T* (${line}) Tj`);
	});
	commands.push("ET");
	const stream = commands.join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index += 1)
		pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(pdf);
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function printHtml(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(body)}</pre></body></html>`;
}
