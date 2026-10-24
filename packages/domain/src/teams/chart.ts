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
function pdfText(text: string) {
	return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
export function drawingSvg(lines: readonly string[]) {
	const texts = lines.map((line, index) => `<text x="50" y="${40 + index * 16}">${xml(line)}</text>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792">${texts}</svg>`;
}
/** A one-page PDF 1.4 with the same lines. Nothing is stored. */
export function drawingPdf(lines: readonly string[]) {
	const commands = ["BT", "/F1 11 Tf", "50 760 Td", "14 TL"];
	lines.forEach((line, index) => {
		if (index) commands.push("T*");
		commands.push(`(${pdfText(line)}) Tj`);
	});
	commands.push("ET");
	const stream = commands.join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
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
