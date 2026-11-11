// Hand-built Word files for the import tests: a stored (uncompressed) zip of the named parts, so each test states the
// exact XML Word would write and the reader sees nothing else.
import { crc32 } from "node:zlib";

export function storedZip(entries) {
	const parts = [];
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = Buffer.from(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(crc32(data) >>> 0, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, data);
	}
	return Buffer.concat(parts);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/** One Word paragraph: `props` is the inside of its w:pPr, `runs` its runs (a string is one text run). */
export const p = (runs = [], props = "") =>
	`<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${[runs]
		.flat()
		.map((run) => (run.startsWith("<") ? run : `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`))
		.join("")}</w:p>`;
export const styled = (styleId, runs) => p(runs, `<w:pStyle w:val="${styleId}"/>`);
export const numbered = (numId, runs, ilvl = 0) =>
	p(runs, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
export const link = (id, text) => `<w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink>`;
export const br = "<w:r><w:br/></w:r>";

/** A paragraph style; `inner` holds its basedOn, pPr and the rest. */
export const style = (id, name, inner = "") =>
	`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;
export const styles = (...list) => `<?xml version="1.0"?><w:styles ${W}>${list.join("")}</w:styles>`;

/** A numbering part: each list is [numId, formats by level], one abstract definition for each. */
export const numbering = (...lists) =>
	`<?xml version="1.0"?><w:numbering ${W}>` +
	lists
		.map(
			([, formats], i) =>
				`<w:abstractNum w:abstractNumId="${i}">${formats
					.map((fmt, ilvl) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/></w:lvl>`)
					.join("")}</w:abstractNum>`,
		)
		.join("") +
	lists.map(([numId], i) => `<w:num w:numId="${numId}"><w:abstractNumId w:val="${i}"/></w:num>`).join("") +
	"</w:numbering>";

/** Relationships of the main part: each is [id, target, external?]. */
export const rels = (...list) =>
	`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
		.map(
			([id, target, external = true]) =>
				`<Relationship Id="${id}" Type="${HYPERLINK}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
		)
		.join("")}</Relationships>`;

/** A .docx file's bytes: the body's paragraphs, with each optional part only when given (a string is the part's XML). */
export function word(body, parts = {}) {
	const entries = [
		{
			name: "word/document.xml",
			data: `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`,
		},
	];
	if (parts.styles !== undefined) entries.push({ name: "word/styles.xml", data: parts.styles });
	if (parts.numbering !== undefined) entries.push({ name: "word/numbering.xml", data: parts.numbering });
	if (parts.rels !== undefined) entries.push({ name: "word/_rels/document.xml.rels", data: parts.rels });
	return storedZip(entries);
}
