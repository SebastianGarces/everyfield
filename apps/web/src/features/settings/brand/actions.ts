"use server";

import type {
	BrandKit,
	BrandReply,
	BrandUploadTicket,
	FinalizeBrandUpload,
	RequestBrandUpload,
	ResetBrandRequest,
	SaveBrandRequest,
} from "../port";
import { finalizeBrandUpload, requestBrandUpload, resetBrandKit, saveBrandKit } from "./server";

export async function saveBrand(request: SaveBrandRequest): Promise<BrandReply<BrandKit>> {
	return saveBrandKit(request);
}

export async function resetBrand(request: ResetBrandRequest): Promise<BrandReply<BrandKit>> {
	return resetBrandKit(request);
}

export async function requestAssetUpload(request: RequestBrandUpload): Promise<BrandReply<BrandUploadTicket>> {
	return requestBrandUpload(request);
}

export async function finalizeAssetUpload(request: FinalizeBrandUpload): Promise<BrandReply<BrandKit>> {
	return finalizeBrandUpload(request);
}
