// T-396 test probe: generates one set of production identity keys and checks each against the app's own parser.
// Prints the verdicts as JSON, never a value. Run with tsx and --conditions=react-server (opt-out.ts is server-only).
import { parseKeyRing } from "../../../packages/domain/src/notifications/opt-out.ts";
import { mailEnv } from "../../../apps/web/src/server/mail-env.ts";
import { generateKeys } from "../../prod-identity/setup.ts";

const keys = generateKeys();
console.log(
	JSON.stringify({
		IDENTITY_SECRET: keys.IDENTITY_SECRET.length >= 32,
		IDENTITY_MAIL_KEY: mailEnv.IDENTITY_MAIL_KEY.safeParse(keys.IDENTITY_MAIL_KEY).success,
		IDENTITY_ADDRESS_KEY: mailEnv.IDENTITY_ADDRESS_KEY.safeParse(keys.IDENTITY_ADDRESS_KEY).success,
		NOTIFICATION_OPT_OUT_KEYS: parseKeyRing(keys.NOTIFICATION_OPT_OUT_KEYS)?.current.length === 32,
		CRON_SECRET: /^[a-f0-9]{64}$/.test(keys.CRON_SECRET),
		fresh: generateKeys().IDENTITY_SECRET !== keys.IDENTITY_SECRET,
	}),
);
