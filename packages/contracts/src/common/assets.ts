import type { z } from "zod";

export type AppAssetPath = string & z.$brand<"AppAssetPath">;

const appAsset = (path: `/${string}`) => path as AppAssetPath;

export const accountAvatarPath = (accountId: string, versionId: string) =>
	appAsset(`/api/accounts/${accountId}/avatar/${versionId}`);
export const personPhotoPath = (personId: string, versionId: string) =>
	appAsset(`/people/${personId}/photo/${versionId}`);
export const brandAssetPath = (fileId: string) => appAsset(`/api/brand/assets/${fileId}`);
