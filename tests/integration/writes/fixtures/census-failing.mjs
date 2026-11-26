import { test } from "node:test";

test("fails", () => {
	throw Error("planted failure");
});
