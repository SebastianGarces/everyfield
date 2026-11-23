import { getViewer } from "@/server/request-context";
import { suggestColorsRequest } from "@everyfield/contracts/branding";
import { getSectionRequest } from "@everyfield/contracts/settings";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { readBrand, suggestBrandColors } from "./brand/server";
import { readRegion, suggestRegion } from "./region-reads";
import { readSection } from "./server";

const ok = async <T>(value: Promise<T>) => ({ status: "ok", value: await value }) as const;

export const GET = defineReads(
	async () => ({ session: await getViewer() }),
	"access_denied",
	(get) => ({
		section: get(getSectionRequest, ({ session }, v) => ok(readSection(session, v))),
		brand: get(z.undefined(), ({ session }) => ok(readBrand(session))),
		colors: get(suggestColorsRequest, ({ session }, v) => ok(suggestBrandColors(session, v))),
		region: get(z.undefined(), ({ session }) => ok(readRegion(session))),
		regions: get(z.unknown(), ({ session }, raw) => ok(suggestRegion(session, raw))),
	}),
);
