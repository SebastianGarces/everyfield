export function pdf() {
	let output = "%PDF-1.4\n";
	const offsets = [0];
	const stream = "BT /F1 12 Tf 20 100 Td (Synthetic PDF) Tj ET";
	for (const [i, body] of [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	].entries()) {
		offsets.push(output.length);
		output += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const start = output.length;
	output += `xref\n0 6\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((n) => String(n).padStart(10, "0") + " 00000 n \n")
		.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
	return new TextEncoder().encode(output);
}
