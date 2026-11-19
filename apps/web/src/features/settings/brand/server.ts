import "server-only";
import { brandError, type BrandKit, type BrandReply } from "@everyfield/contracts/branding";
import { eq } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { privateStorage } from "@everyfield/db/schema";
import { brandReader, brandWriter, readBrandAssetIfChanged, uploadBrandAsset } from "@everyfield/domain/branding";
import { randomUUID } from "node:crypto";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { BrandView } from "../port";
import { logFailure, type LogWord } from "@everyfield/domain/log";

type Db = NonNullable<ReturnType<typeof requestDatabase>>;
type Actor = Awaited<ReturnType<typeof getViewer>>["authority"];

const unavailable = (): BrandReply<never> => ({
	status: "refused",
	error: brandError.parse({ code: "unavailable", details: {}, correlationId: randomUUID(), retry: "never" }),
});

type Session = Awaited<ReturnType<typeof getViewer>>;
type Call<T> = (db: Db, actor: NonNullable<Actor>) => Promise<BrandReply<T>>;

const run = async <T, O extends string>(outcome: LogWord<O>, call: Call<T>) => runAs(await getViewer(), outcome, call);

async function runAs<T, O extends string>(viewer: Session, outcome: LogWord<O>, call: Call<T>) {
	const db = requestDatabase();
	if (viewer.status !== "active" || !viewer.authority) return unavailable();
	try {
		return await call(db, viewer.authority);
	} catch (error) {
		logFailure({ component: "brand", outcome }, error);
		return unavailable();
	}
}

export function readBrand(viewer: Session): Promise<BrandReply<BrandView>> {
	return runAs(viewer, "read_failed", async (db, actor) => {
		const context = actor.actor.context;
		const plantId = context.kind === "seat" && context.owner.kind === "plant" ? context.owner.id : null;
		const [reply, named] = await Promise.all([
			brandReader.get(db, actor, {}),
			plantId
				? db.select({ name: t.plant.name }).from(t.plant).where(eq(t.plant.id, plantId)).limit(1)
				: Promise.resolve([]),
		]);
		if (reply.status === "refused") return reply;
		const churchName = named[0]?.name;
		return churchName ? { status: "ok", value: { kit: reply.value, churchName } } : unavailable();
	});
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

export function suggestBrandColors(viewer: Session, raw: unknown) {
	return runAs(viewer, "suggest_failed", (db, actor) => brandReader.suggestColors(db, actor, raw, privateStorage()));
}

export function storeBrandBytes(uploadId: string, bytes: Uint8Array) {
	return run("upload_bytes_failed", (db, actor) => uploadBrandAsset(db, privateStorage(), actor, { uploadId, bytes }));
}

export function brandAsset(fileId: string, current: (sha256: string) => boolean) {
	return run("read_asset_failed", (db, actor) => readBrandAssetIfChanged(db, privateStorage(), actor, fileId, current));
}
