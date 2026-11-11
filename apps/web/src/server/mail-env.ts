// The identity mail fields every server mount parses from process.env: the two 32-byte hex keys that encrypt mail and
// hash addresses, and the sender. Each mount spreads `mailEnv` into its own z.object. Relative imports only and no
// "server-only", so node tests can import it by path.
import { z } from "zod";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailEnv = {
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
};
