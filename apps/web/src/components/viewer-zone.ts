import { allZones } from "./time.ts";

export const ZONE_COOKIE = "ef-zone";

export const ZONE_COOKIE_SCRIPT = `try{var z=encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);if(document.cookie.split("; ").indexOf("${ZONE_COOKIE}="+z)<0)document.cookie="${ZONE_COOKIE}="+z+"; Path=/; Max-Age=31536000; SameSite=Lax"}catch(e){}`;

export const viewerZone = (zone: string | undefined): string | null =>
	zone !== undefined && allZones().includes(zone) ? zone : null;
