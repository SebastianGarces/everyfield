import "server-only";

/** The same wrapped lines feed the SVG and the PDF. */
export function wrapLabel(text: string, width = 42): string[] {
	const lines: string[] = [];
	for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width));
	return lines.length ? lines : [text];
}
export function drawingLines(nodes: readonly { name: string; leaderName: string | null; archived: boolean }[]) {
	const lines: string[] = ["Organization"];
	for (const node of nodes) {
		lines.push(...wrapLabel(node.archived ? `${node.name} (archived)` : node.name));
		if (node.leaderName) lines.push(...wrapLabel(`Leader: ${node.leaderName}`));
	}
	return lines;
}
function xml(text: string) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** WinAnsi bytes 0x80 to 0x9F, which differ from Latin-1. Every other byte from 0xA0 up is its Latin-1 character. */
const winAnsiHigh = new Map(
	[..."€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ"]
		.map((char, index) => [char, 0x80 + index] as const)
		.filter(([char]) => char.charCodeAt(0) > 0x9f),
);
/** A PDF string body in WinAnsi: ASCII as itself, other WinAnsi characters as octal escapes, anything else as "?". */
function pdfText(text: string) {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0)!;
		const byte = code >= 0x20 && code < 0x7f ? code : code >= 0xa0 && code <= 0xff ? code : winAnsiHigh.get(char);
		if (byte === undefined) out += "?";
		else if (byte >= 0x80) out += `\\${byte.toString(8)}`;
		else if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
		else out += char;
	}
	return out;
}
const svgTop = 40;
const svgLeading = 16;
export function drawingSvg(lines: readonly string[]) {
	const texts = lines
		.map((line, index) => `<text x="50" y="${svgTop + index * svgLeading}">${xml(line)}</text>`)
		.join("");
	// A long chart grows the drawing so the last line stays inside it, with the same margin below as above.
	const height = Math.max(792, svgTop * 2 + (lines.length - 1) * svgLeading);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="${height}" viewBox="0 0 612 ${height}">${texts}</svg>`;
}
const pageTop = 760;
const pageLeading = 14;
/** Lines that fit between the first baseline and a 40 pt bottom margin on a US Letter page. */
const pdfLinesPerPage = Math.floor((pageTop - 40) / pageLeading) + 1;
/** A PDF 1.4 with the same lines, as many US Letter pages as they need. Nothing is stored. */
export function drawingPdf(lines: readonly string[]) {
	const pages: (readonly string[])[] = [];
	for (let index = 0; index < lines.length; index += pdfLinesPerPage)
		pages.push(lines.slice(index, index + pdfLinesPerPage));
	if (!pages.length) pages.push([]);
	// Objects 1 to 3 are the catalog, the page tree and the font; each page then takes a page and a content object.
	const pageId = (index: number) => 4 + index * 2;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pages.map((_, index) => `${pageId(index)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	];
	pages.forEach((page, index) => {
		const commands = ["BT", "/F1 11 Tf", `50 ${pageTop} Td`, `${pageLeading} TL`];
		page.forEach((line, at) => {
			if (at) commands.push("T*");
			commands.push(`(${pdfText(line)}) Tj`);
		});
		commands.push("ET");
		const stream = commands.join("\n");
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId(index) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		);
	});
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n`;
	body += "0000000000 65535 f \n";
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return body;
}
