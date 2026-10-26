import { crc32, inflateRawSync } from "node:zlib";

const UPLOAD_MAX = 10 * 1024 * 1024;
const EXPANDED_MAX = 40 * 1024 * 1024;
const ENTRY_MAX = 2000;
const TEXT_MAX = 2_000_000;
const PARSE_MS = 15_000;
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

export class ImportRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportRejected";
	}
}

/** UTF-8 text or a modern Word document, as editable text. Legacy Word, macros and remote targets are refused. */
export function readImport(bytes: Uint8Array, format: "text" | "docx"): string {
	if (bytes.length > UPLOAD_MAX) throw new ImportRejected("The file must be 10 MiB or smaller.");
	if (isOle(bytes)) throw new ImportRejected("Legacy Word documents are not accepted.");
	if (format === "text") return readText(bytes);
	return readDocx(bytes);
}

function isOle(bytes: Uint8Array) {
	return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

function readText(bytes: Uint8Array) {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ImportRejected("Text must be UTF-8.");
	}
	if (text.includes("\u0000")) throw new ImportRejected("Text contains a null character.");
	if (!text.trim()) throw new ImportRejected("Imported text is empty.");
	if (text.length > TEXT_MAX) throw new ImportRejected("Imported text is too long.");
	return text;
}

function readDocx(bytes: Uint8Array) {
	const entries = unzip(bytes);
	for (const name of entries.keys()) {
		const folded = name.toLowerCase();
		if (folded.includes("vba") || folded.includes("embeddings") || folded.includes("activex"))
			throw new ImportRejected("Word macros and embedded objects are not accepted.");
	}
	for (const [name, data] of entries) {
		if (!name.toLowerCase().endsWith(".rels")) continue;
		refuseExternal(data.toString("utf8"));
	}
	const xml = entries.get("word/document.xml");
	if (!xml) throw new ImportRejected("The Word file has no document text.");
	const text = wordText(xml.toString("utf8"));
	if (!text.trim()) throw new ImportRejected("Imported text is empty.");
	if (text.length > TEXT_MAX) throw new ImportRejected("Imported text is too long.");
	return text;
}

function unzip(bytes: Uint8Array) {
	const started = Date.now();
	const entries = new Map<string, Buffer>();
	let offset = 0;
	let declared = 0;
	while (offset + 4 <= bytes.length) {
		if (Date.now() - started > PARSE_MS) throw new ImportRejected("The Word file took too long to read.");
		const sig = u32(bytes, offset);
		if (sig === CENTRAL || sig === EOCD) break;
		if (sig !== LOCAL) throw new ImportRejected("The Word file is not a valid document.");
		if (offset + 30 > bytes.length) throw new ImportRejected("The Word file is not a valid document.");
		const flags = u16(bytes, offset + 6);
		const method = u16(bytes, offset + 8);
		const crc = u32(bytes, offset + 14);
		const compressed = u32(bytes, offset + 18);
		const uncompressed = u32(bytes, offset + 22);
		const nameLen = u16(bytes, offset + 26);
		const extraLen = u16(bytes, offset + 28);
		if (flags & 0x1) throw new ImportRejected("Encrypted Word files are not accepted.");
		if (flags & 0x8) throw new ImportRejected("The Word file is not a valid document.");
		if (method !== 0 && method !== 8) throw new ImportRejected("The Word file is not a valid document.");
		const nameAt = offset + 30;
		const dataAt = nameAt + nameLen + extraLen;
		const dataEnd = dataAt + compressed;
		if (dataEnd > bytes.length) throw new ImportRejected("The Word file is not a valid document.");
		const name = Buffer.from(bytes.subarray(nameAt, nameAt + nameLen)).toString("utf8");
		refuseName(name);
		if (entries.has(name)) throw new ImportRejected("The Word file is not a valid document.");
		if (entries.size >= ENTRY_MAX) throw new ImportRejected("The Word file has too many parts.");
		declared += uncompressed;
		if (declared > EXPANDED_MAX) throw new ImportRejected("The Word file expands past 40 MiB.");
		const raw = Buffer.from(bytes.subarray(dataAt, dataEnd));
		const data = method === 0 ? raw : inflate(raw);
		if (data.length !== uncompressed) throw new ImportRejected("The Word file is not a valid document.");
		if (crc32(data) >>> 0 !== crc) throw new ImportRejected("The Word file is not a valid document.");
		entries.set(name, data);
		offset = dataEnd;
	}
	if (entries.size === 0) throw new ImportRejected("The Word file is not a valid document.");
	return entries;
}

function inflate(raw: Buffer) {
	try {
		return inflateRawSync(raw);
	} catch {
		throw new ImportRejected("The Word file is not a valid document.");
	}
}

function refuseName(name: string) {
	if (!name || name.includes("\\") || name.includes("\u0000") || name.startsWith("/") || name.startsWith("\\"))
		throw new ImportRejected("The Word file is not a valid document.");
	if (name.split("/").some((part) => part === "" || part === "." || part === ".."))
		throw new ImportRejected("The Word file is not a valid document.");
}

function refuseExternal(xml: string) {
	const tags = xml.match(/<Relationship\b[^>]*\/>/gi) ?? [];
	for (const tag of tags) {
		const mode = attr(tag, "TargetMode");
		const target = attr(tag, "Target") ?? "";
		const type = (attr(tag, "Type") ?? "").toLowerCase();
		if (target.split("/").some((part) => part === "..") || target.toLowerCase().startsWith("file:"))
			throw new ImportRejected("The Word file points outside the document.");
		if (mode?.toLowerCase() !== "external") continue;
		if (!type.endsWith("/hyperlink")) throw new ImportRejected("The Word file points outside the document.");
	}
}

function attr(tag: string, name: string) {
	const found = new RegExp(String.raw`\b${name}\s*=\s*"([^"]*)"`, "i").exec(tag);
	return found?.[1] ?? null;
}

function wordText(xml: string) {
	let out = "";
	const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
	for (const found of xml.matchAll(pattern)) {
		out += decodeEntities(found[1] ?? "");
		if (out.length > TEXT_MAX) throw new ImportRejected("Imported text is too long.");
	}
	return out;
}

function decodeEntities(value: string) {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function u16(bytes: Uint8Array, offset: number) {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number) {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
