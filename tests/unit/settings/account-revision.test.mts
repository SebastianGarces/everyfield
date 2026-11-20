import assert from "node:assert/strict";
import { test } from "node:test";

const { createSettingsStore, withAccountRevision } =
	await import("../../../apps/web/src/features/settings/settings.store.ts");
const { createFixturePort } = await import("../../../apps/web/src/features/settings/preview/fixtures.ts");

test("BUG-account-revision: a Notifications save while Your account is shown lets the next name save through", async () => {
	const { port } = createFixturePort("admin");
	const store = createSettingsStore({ port, seed: null });
	const account = await port.getSection({ section: "account" });
	const notifications = await port.getSection({ section: "notifications" });
	assert.ok(account.status === "ok" && account.value.section === "account");
	assert.ok(notifications.status === "ok" && notifications.value.section === "notifications");

	const choice = notifications.value.values.choices[0]!;
	const flipped = await port.saveSection({
		requestKey: "notifications-1",
		expectedRevision: notifications.value.revision,
		input: { section: "notifications", patch: { kind: "channel", choice: { ...choice, enabled: !choice.enabled } } },
	});
	assert.ok(flipped.status === "ok");
	store.getState().actions.replaceSection({ section: "notifications" }, flipped.value.current);

	const shown = withAccountRevision(account.value, store.getState().accountRevision);
	assert.ok(shown.section === "account");
	const saved = await port.saveSection({
		requestKey: "account-1",
		expectedRevision: shown.revision,
		input: { section: "account", name: "Renamed" },
	});
	assert.equal(saved.status, "ok");
});
