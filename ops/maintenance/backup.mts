import { createHash, type KeyObject } from "node:crypto";
import type { BackupBucket, Remain, Retention, StoredObject } from "./bucket.mts";
import { CaptureRefused, KEEP_MS } from "./capture.mts";
import { OperatorRefused } from "./control.mts";
import { COPY_OPERATION, createEncryptedCopy, openEncryptedCopy, SEALED_BYTES } from "./copy.mts";
import { manifestSchema } from "./recovery.mts";
import { FALLBACK_HOURS, type Snapshot } from "./restore.mts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_DAYS = 7;
const UPLOAD_HOURS = 6;
const LATE_HOURS = 26;
const CAPTURE_ATTEMPTS = 3;
const SCHEDULE = "schedule.json";
const LOCATION = /^(copy\/[0-9-]{10}\/[0-9a-f-]{36})\/(.+)$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const day = (at: Date) => at.toISOString().slice(0, 10);

const backupOperator = {
	authority: "authorized_restricted_backup_operator",
	verified: true,
	operation_ids: [COPY_OPERATION],
	environment: "isolated-test",
} as const;

export type BackupDeps = {
	bucket: BackupBucket;
	key: KeyObject;
	capture: () => Promise<Snapshot>;
	clock: () => Date;
};
export type BackupResult =
	| {
			copy_complete: true;
			location: string;
			created_at: string;
			expires_at: string;
			database_bytes: number;
			files: number;
			verified_at: string;
	  }
	| { copy_complete: false; refusal: string };

async function capture(deps: BackupDeps): Promise<Snapshot> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await deps.capture();
		} catch (error) {
			if (!(error instanceof CaptureRefused) || attempt === CAPTURE_ATTEMPTS) throw error;
		}
	}
}

export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
	if (!(await deps.bucket.get(SCHEDULE)))
		await deps.bucket.put(SCHEDULE, Buffer.from(JSON.stringify({ started_at: deps.clock().toISOString() })));
	let snapshot: Snapshot;
	try {
		snapshot = await capture(deps);
	} catch (error) {
		return { copy_complete: false, refusal: error instanceof OperatorRefused ? error.code : "capture_failed" };
	}
	const result = await createEncryptedCopy(
		{ store: deps.bucket, clock: deps.clock },
		{ capability: backupOperator, key: deps.key, source: { snapshot } },
	);
	if (!result.copy_encrypted) return { copy_complete: false, refusal: result.refusal };
	try {
		const opened = await openEncryptedCopy(deps.bucket, result.location, deps.key);
		const captured = manifestSchema.parse(snapshot.manifest);
		const stored = manifestSchema.parse(opened.manifest);
		const same =
			JSON.stringify({ ...stored, keyVersion: "" }) === JSON.stringify({ ...captured, keyVersion: "" }) &&
			sha256(opened.image) === captured.database.sha256 &&
			opened.objects.size === captured.objects.length &&
			captured.objects.every((o) => sha256(opened.objects.get(o.id) ?? Buffer.alloc(0)) === o.sha256);
		if (!same) return { copy_complete: false, refusal: "readback_mismatch" };
		const manifest = await deps.bucket.get(`${result.location}/manifest.json`);
		if (!manifest) return { copy_complete: false, refusal: "readback_mismatch" };
		const verifiedAt = deps.clock().toISOString();
		await deps.bucket.put(
			`${result.location}/verified.json`,
			Buffer.from(JSON.stringify({ manifest_sha256: sha256(manifest), verified_at: verifiedAt })),
		);
		return {
			copy_complete: true,
			location: result.location,
			created_at: captured.createdAt,
			expires_at: captured.expiresAt,
			database_bytes: captured.database.bytes,
			files: captured.objects.length,
			verified_at: verifiedAt,
		};
	} catch {
		return { copy_complete: false, refusal: "readback_failed" };
	}
}

export type BucketCopy = {
	location: string;
	date: string;
	created_at: string | null;
	age_hours: number | null;
	bytes: number;
	expires_at: string;
	state: "complete" | "incomplete" | "uploading" | "expired";
};

const parsed = (bytes: Uint8Array | null): unknown => {
	try {
		return bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
	} catch {
		return null;
	}
};

async function readCopy(
	bucket: BackupBucket,
	location: string,
	stored: StoredObject[],
	now: Date,
): Promise<BucketCopy> {
	const sizes = new Map(stored.map((o) => [o.key.slice(location.length + 1), o.bytes]));
	const bytes = stored.reduce((total, o) => total + o.bytes, 0);
	const date = location.split("/")[1]!;
	const manifestBytes = sizes.has("manifest.json") ? await bucket.get(`${location}/manifest.json`) : null;
	const manifest = manifestSchema.safeParse(parsed(manifestBytes));
	const marker = sizes.has("verified.json") ? parsed(await bucket.get(`${location}/verified.json`)) : null;
	const verified =
		manifestBytes !== null &&
		(marker as { manifest_sha256?: unknown } | null)?.manifest_sha256 === sha256(manifestBytes);
	if (!manifest.success) {
		const written = Math.max(...stored.map((o) => Date.parse(o.modifiedAt)));
		const until = new Date(written + UPLOAD_HOURS * HOUR);
		return {
			location,
			date,
			created_at: null,
			age_hours: null,
			bytes,
			expires_at: until.toISOString(),
			state: until <= now ? "expired" : "uploading",
		};
	}
	const m = manifest.data;
	const whole =
		sizes.get("key") === 32 + SEALED_BYTES &&
		sizes.get("database") === m.database.bytes + SEALED_BYTES &&
		m.objects.every((o) => sizes.get(`objects/${o.id}`) === o.bytes + SEALED_BYTES);
	const expires = Math.min(Date.parse(m.expiresAt), ...m.subjects.map((s) => Date.parse(s.expiresAt)));
	return {
		location,
		date,
		created_at: m.createdAt,
		age_hours: Math.round(((now.getTime() - Date.parse(m.createdAt)) / HOUR) * 100) / 100,
		bytes,
		expires_at: new Date(expires).toISOString(),
		state: expires <= now.getTime() ? "expired" : verified && whole ? "complete" : "incomplete",
	};
}

export async function readCopies(bucket: BackupBucket, now: Date): Promise<BucketCopy[]> {
	const byLocation = new Map<string, StoredObject[]>();
	for (const o of await bucket.list()) {
		const location = LOCATION.exec(o.key)?.[1];
		if (location) byLocation.set(location, [...(byLocation.get(location) ?? []), o]);
	}
	return Promise.all(
		[...byLocation].sort(([a], [b]) => a.localeCompare(b)).map(([at, stored]) => readCopy(bucket, at, stored, now)),
	);
}

export type ExpiryResult = {
	checked_at: string;
	deleted: string[];
	kept: string[];
	remains: Remain[];
	retention: Retention;
	expiry_proven: boolean;
	failing: string[];
};

export async function expireCopies(bucket: BackupBucket, now: Date): Promise<ExpiryResult> {
	const copies = await readCopies(bucket, now);
	const expired = copies.filter((c) => c.state === "expired").map((c) => c.location);
	for (const location of expired) {
		const keys = (await bucket.list()).map((o) => o.key).filter((key) => key.startsWith(`${location}/`));
		for (const key of keys.sort((a, b) => Number(a.endsWith("manifest.json")) - Number(b.endsWith("manifest.json"))))
			await bucket.delete(key);
	}
	const left = (await bucket.list()).map((o) => o.key);
	const remains = await bucket.remains();
	const retention = await bucket.retention();
	const failing = [
		...expired.filter((location) => left.some((key) => key.startsWith(`${location}/`))).map((l) => `not_deleted:${l}`),
		...remains.map((r) => `deleted_copy_recoverable:${r.key}`),
		...Object.entries(retention).flatMap(([setting, value]) => (value === "off" ? [] : [`${setting}_${value}`])),
	];
	return {
		checked_at: now.toISOString(),
		deleted: expired,
		kept: copies.filter((c) => c.state !== "expired").map((c) => c.location),
		remains,
		retention,
		expiry_proven: failing.length === 0,
		failing,
	};
}

export type DayState = { date: string; state: "complete" | "failed" | "missed" | "due" };
export type CopyStatus = {
	checked_at: string;
	kept_days: number;
	copies: BucketCopy[];
	days: DayState[];
	newest_complete_age_hours: number | null;
	daily_fallback_eligible: boolean;
	app_key_restriction: "open" | "closed";
	customer_data_gate: "blocked";
	failing: string[];
};

export async function copyStatus(
	bucket: BackupBucket,
	now: Date,
	appKeys: "open" | "closed" = "open",
): Promise<CopyStatus> {
	const copies = await readCopies(bucket, now);
	const started = (parsed(await bucket.get(SCHEDULE)) as { started_at?: string } | null)?.started_at;
	const first = started ? Date.parse(day(new Date(started))) : 0;
	const today = Date.parse(day(now));
	const complete = copies.filter((c) => c.state === "complete");
	const ages = complete.map((c) => c.age_hours!);
	const newest = ages.length ? Math.min(...ages) : null;
	const days: DayState[] = [];
	for (let back = KEEP_DAYS - 1; back >= 0; back--) {
		const at = today - back * DAY;
		if (at < first || now.getTime() >= at + KEEP_MS) continue;
		const date = day(new Date(at));
		const attempts = copies.filter((c) => (c.created_at ?? c.date).slice(0, 10) === date);
		const done = attempts.some((c) => c.state === "complete");
		const state = done
			? "complete"
			: attempts.some((c) => c.state === "incomplete")
				? "failed"
				: back === 0 && newest !== null && newest <= LATE_HOURS
					? "due"
					: "missed";
		days.push({ date, state });
	}
	const failing = [
		...(newest === null ? ["no_complete_copy"] : newest > LATE_HOURS ? ["newest_copy_stale"] : []),
		...days.filter((d) => d.state === "missed" || d.state === "failed").map((d) => `${d.state}_day:${d.date}`),
		...copies.filter((c) => c.state === "expired").map((c) => `expired_copy_remains:${c.location}`),
		...(appKeys === "open" ? ["app_key_restriction_open"] : []),
	];
	return {
		checked_at: now.toISOString(),
		kept_days: KEEP_DAYS,
		copies,
		days,
		newest_complete_age_hours: newest,
		daily_fallback_eligible: newest !== null && newest <= FALLBACK_HOURS,
		app_key_restriction: appKeys,
		customer_data_gate: "blocked",
		failing,
	};
}
