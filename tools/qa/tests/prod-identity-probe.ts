import { parseKeyRing } from "../../../packages/domain/src/notifications/opt-out.ts";
import { mailKeys } from "../../../apps/web/src/server/config.ts";
import { generateKeys } from "../../prod-identity/setup.ts";

const keys = generateKeys();
console.log(
	JSON.stringify({
		IDENTITY_SECRET: keys.IDENTITY_SECRET.length >= 32,
		IDENTITY_MAIL_KEY: mailKeys.shape.IDENTITY_MAIL_KEY.safeParse(keys.IDENTITY_MAIL_KEY).success,
		IDENTITY_ADDRESS_KEY: mailKeys.shape.IDENTITY_ADDRESS_KEY.safeParse(keys.IDENTITY_ADDRESS_KEY).success,
		NOTIFICATION_OPT_OUT_KEYS: parseKeyRing(keys.NOTIFICATION_OPT_OUT_KEYS)?.current.length === 32,
		CRON_SECRET: /^[a-f0-9]{64}$/.test(keys.CRON_SECRET),
		fresh: generateKeys().IDENTITY_SECRET !== keys.IDENTITY_SECRET,
	}),
);
