import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Uint8Array; /** Store the bytes as they are (images). */ store?: boolean };

// A zero DOS date and time: the same bytes for the same entries, on every run.
const DOS_TIME = 0;
const DOS_DATE = 0;

/** A deterministic ZIP archive: entries in the order given, a fixed date and no extra fields. */
export function zip(entries: readonly ZipEntry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.data);
		const packed = entry.store ? raw : deflateRawSync(raw, { level: 9 });
		const method = entry.store ? 0 : 8;
		const flags = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : 0x0800; // the UTF-8 flag only for non-ASCII names
		const checksum = crc32(raw) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, packed);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(20, 6);
		head.writeUInt16LE(flags, 8);
		head.writeUInt16LE(method, 10);
		head.writeUInt16LE(DOS_TIME, 12);
		head.writeUInt16LE(DOS_DATE, 14);
		head.writeUInt32LE(checksum, 16);
		head.writeUInt32LE(packed.length, 20);
		head.writeUInt32LE(raw.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(offset, 42);
		central.push(head, name);
		offset += local.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}
