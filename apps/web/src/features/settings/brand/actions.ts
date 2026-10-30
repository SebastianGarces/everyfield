"use server";

import type { BrandKit, BrandReply, BrandView, ResetBrandRequest, SaveBrandRequest } from "../port";
import { readBrand, resetBrandKit, saveBrandKit } from "./server";

// The brand kit server actions: one per operation the Brand kit section uses. The domain parses each request with the
// branding contract, and the church comes from the session, never from the browser.

export async function getBrand(): Promise<BrandReply<BrandView>> {
	return readBrand();
}

export async function saveBrand(request: SaveBrandRequest): Promise<BrandReply<BrandKit>> {
	return saveBrandKit(request);
}

export async function resetBrand(request: ResetBrandRequest): Promise<BrandReply<BrandKit>> {
	return resetBrandKit(request);
}
