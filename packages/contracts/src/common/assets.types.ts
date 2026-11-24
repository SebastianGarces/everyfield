import type { AppAssetPath } from "./assets.ts";
import { accountAvatarPath, brandAssetPath, personPhotoPath } from "./assets.ts";
import { listPhotoRoute } from "../people/results.ts";
import { avatarRoute } from "../settings/results.ts";

type Refused<Target, Value> = [Value] extends [Target] ? false : true;

export const aPlainStringIsRefused: Refused<AppAssetPath, string> = true;
export const aTemplateLiteralIsRefused: Refused<AppAssetPath, `/api/accounts/${string}/avatar/${string}`> = true;
export const anObjectStoreUrlIsRefused: Refused<AppAssetPath, `https://${string}`> = true;

export const theBuildersAreAccepted: Refused<
	AppAssetPath,
	ReturnType<
		| typeof accountAvatarPath
		| typeof personPhotoPath
		| typeof brandAssetPath
		| typeof avatarRoute
		| typeof listPhotoRoute
	>
> = false;
