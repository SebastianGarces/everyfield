import "server-only";
import { eq } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/onboarding";
import type { OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import { actor, deny, parse, reply, seatless, type Tx } from "./core.ts";
import { creation, profile, type OnboardingEffects } from "./creation.ts";
import { setup } from "./setup.ts";
export type { OnboardingEffects };

export function createOnboardingProducer(effects: OnboardingEffects): OnboardingProducer<Tx> {
	return {
		...creation(effects),
		...setup,
		async getDiscoveryProfile(tx, ctx, raw) {
			return reply(tx, async () => {
				parse(c.getDiscoveryProfileRequest, raw);
				if (ctx.selected.kind !== "account") deny();
				const a = await actor(tx, ctx);
				const [d] = await tx.select().from(t.discovery).where(eq(t.discovery.account_id, a.account.id));
				if (!d) return c.discoveryProfileResult.parse({ status: "unavailable" });
				if (d.converted_at)
					return c.discoveryProfileResult.parse({
						status: "converted",
						discoveryId: d.id,
						plant: { kind: "plant", id: d.converted_plant_id },
						convertedAt: d.converted_at.toISOString(),
					});
				await seatless(tx, a.account.id);
				return c.discoveryProfileResult.parse({ status: "active", profile: await profile(tx, a.account.id, d) });
			});
		},
	};
}

export { readOnboardingEntry, readOnboardingNoticeRecipients } from "./reads.ts";
export type { RawEntry } from "./reads.ts";
