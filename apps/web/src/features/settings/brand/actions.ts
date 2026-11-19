"use server";

import type { BrandKit, BrandReply, BrandUploadTicket } from "../port";
import { finalizeBrandUpload, requestBrandUpload, resetBrandKit, saveBrandKit } from "./server";

export async function saveBrand(request: unknown): Promise<BrandReply<BrandKit>> {
	return saveBrandKit(request);
}

export async function resetBrand(request: unknown): Promise<BrandReply<BrandKit>> {
	return resetBrandKit(request);
}

export async function requestAssetUpload(request: unknown): Promise<BrandReply<BrandUploadTicket>> {
	return requestBrandUpload(request);
}

export async function finalizeAssetUpload(request: unknown): Promise<BrandReply<BrandKit>> {
	return finalizeBrandUpload(request);
}
