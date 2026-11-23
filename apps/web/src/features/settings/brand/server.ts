import "server-only";
import { brandError, type BrandKit, type BrandReply } from "@everyfield/contracts/branding";
import { privateStorage } from "@everyfield/db/schema";
import { brandReader, brandWriter, readBrandAssetIfChanged, uploadBrandAsset } from "@everyfield/domain/branding";
import { randomUUID } from "node:crypto";
import { requestDatabase } from "@/server/database";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { getViewer, type Viewer } from "@/server/request-context";
import type { BrandView } from "../port";
import { type LogWord } from "@everyfield/domain/log";
import { transient } from "../../../server/platform/transient.ts";

const unavailable = (): BrandReply<never> => ({
	status: "refused",
	error: brandError.parse({ code: "unavailable", details: {}, correlationId: randomUUID(), retry: "never" }),
});

type Call<T> = (db: Database, actor: RequestActor) => Promise<BrandReply<T>>;

const run = async <T, O extends string>(outcome: LogWord<O>, call: Call<T>) => runAs(await getViewer(), outcome, call);

async function runAs<T, O extends string>(viewer: Viewer, outcome: LogWord<O>, call: Call<T>) {
	const authority = viewer.authority;
	if (!authority) return unavailable();
	const db = requestDatabase();
	return transient({ component: "brand", outcome }, () => call(db, authority), unavailable());
}

export function readBrand(viewer: Viewer): Promise<BrandReply<BrandView>> {
	return runAs(viewer, "read_failed", (db, actor) => brandReader.getSettings(db, actor, {}));
}

export function saveBrandKit(raw: unknown): Promise<BrandReply<BrandKit>> {
	return run("save_failed", (db, actor) => brandWriter.saveSettings(db, actor, raw));
}

export function resetBrandKit(raw: unknown): Promise<BrandReply<BrandKit>> {
	return run("reset_failed", (db, actor) => brandWriter.reset(db, actor, raw));
}

export function requestBrandUpload(raw: unknown) {
	return run("request_upload_failed", (db, actor) => brandWriter.requestUpload(db, actor, raw));
}

export function finalizeBrandUpload(raw: unknown) {
	return run("finalize_upload_failed", (db, actor) => brandWriter.finalizeUpload(db, actor, raw));
}

export function suggestBrandColors(viewer: Viewer, raw: unknown) {
	return runAs(viewer, "suggest_failed", (db, actor) => brandReader.suggestColors(db, actor, raw, privateStorage()));
}

export function storeBrandBytes(uploadId: string, bytes: Uint8Array) {
	return run("upload_bytes_failed", (db, actor) => uploadBrandAsset(db, privateStorage(), actor, { uploadId, bytes }));
}

export function brandAsset(fileId: string, current: (sha256: string) => boolean) {
	return run("read_asset_failed", (db, actor) => readBrandAssetIfChanged(db, privateStorage(), actor, fileId, current));
}
