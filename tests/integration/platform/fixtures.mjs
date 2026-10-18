import { requireApp } from './support.mjs';
const { zipSync, strToU8 } = requireApp('fflate');
export function office(format, text = 'Synthetic document') {
  const files = { '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), '_rels/.rels': strToU8('<Relationships/>') };
  if (format === 'docx') files['word/document.xml'] = strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  else { files['xl/workbook.xml'] = strToU8('<workbook/>'); files['xl/worksheets/sheet1.xml'] = strToU8(`<worksheet><sheetData><row><c t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`); }
  return zipSync(files);
}
export function pdf() {
  let output = '%PDF-1.4\n'; const offsets = [0];
  const stream = 'BT /F1 12 Tf 20 100 Td (Synthetic PDF) Tj ET';
  for (const [i, body] of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`].entries()) { offsets.push(output.length); output += `${i+1} 0 obj\n${body}\nendobj\n`; }
  const start = output.length; output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(output);
}
