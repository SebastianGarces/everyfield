export const SERVER_ENV = {
	IDENTITY_ORIGIN: "https://app.everyfield.test",
	IDENTITY_DATABASE_URL: "postgres://unused.test/runtime",
	IDENTITY_AUTH_DATABASE_URL: "postgres://unused.test/auth",
	IDENTITY_SECRET: "s".repeat(32),
	IDENTITY_MAIL_KEY: "a".repeat(64),
	IDENTITY_ADDRESS_KEY: "b".repeat(64),
	IDENTITY_MAIL_FROM: "church@resend.dev",
};

export const setServerEnv = (values: Partial<Record<keyof typeof SERVER_ENV, string>> = {}) =>
	Object.assign(process.env, SERVER_ENV, values);
