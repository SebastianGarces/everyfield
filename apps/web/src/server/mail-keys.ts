import { z } from "zod";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailKeys = z.object({
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
});
