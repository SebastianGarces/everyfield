"use server";

import type {
	BrandKit,
	BrandReply,
	BrandUploadTicket,
	BrandView,
	FinalizeBrandUpload,
	RequestBrandUpload,
	ResetBrandRequest,
	SaveBrandRequest,
	SuggestBrandColors,
	SuggestedColors,
} from "../port";
import {
	finalizeBrandUpload,
	readBrand,
	requestBrandUpload,
	resetBrandKit,
	saveBrandKit,
	suggestBrandColors,
} from "./server";

export async function getBrand(): Promise<BrandReply<BrandView>> {
	return readBrand();
}

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

export async function suggestColors(request: SuggestBrandColors): Promise<BrandReply<SuggestedColors>> {
	return suggestBrandColors(request);
}
