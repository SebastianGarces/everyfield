// S2 task 29b: every clickable shared control shows a pointer cursor when enabled and not-allowed when disabled.
// The product-root rule in controls.css also reaches raw buttons outside controls (the AppShell). The test reads the
// computed cursor in a real browser and asserts the exact value; a failure names the element by role and name.
// It runs against a running app through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

const cursorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).cursor);

/** Non-interactive surfaces keep the default cursor. Engines report it as "auto" or "default". */
async function expectDefault(locator, what) {
	const value = await cursorOf(locator.first());
	assert.ok(["auto", "default"].includes(value), `${what}: cursor is ${value}, expected the default`);
}

/** Text fields keep the text cursor. WebKit reports it as "auto" for a field, so the check rules out the button cursors. */
async function expectText(locator, what) {
	const value = await cursorOf(locator.first());
	assert.ok(["text", "auto"].includes(value), `${what}: cursor is ${value}, expected the text cursor`);
}

/** Asserts that `locator` computes `expected`. `what` names the element in the failure message. */
async function expectCursor(locator, expected, what) {
	const target = locator.first();
	await target.waitFor({ state: "attached", timeout: 5000 }).catch(() => assert.fail(`${what}: element not found`));
	assert.equal(await cursorOf(target), expected, `${what}: cursor`);
}

for (const [name, engine] of ENGINES) {
	test(`BUG-S2-T29b (${name}): clickable controls show the right cursor`, { timeout: 120_000 }, () =>
		withPage(engine, async (page) => {
			await page.goto(BASE + "/design/controls");
			await page.locator("html[data-theme]").waitFor({ state: "attached", timeout: 60_000 });

			const role = (r, n, scope = page) => scope.getByRole(r, { name: n, exact: true });
			// Items whose name carries a shortcut or description (a menu item, a command item).
			const loose = (r, n, scope = page) => scope.getByRole(r, { name: n });
			const pointer = (loc, what) => expectCursor(loc, "pointer", what);
			const blocked = (loc, what) => expectCursor(loc, "not-allowed", what);
			const label = (text) => page.locator("label", { hasText: text });
			const closeOverlay = async () => {
				await page.keyboard.press("Escape");
				await page.locator('[role="dialog"], [role="menu"], [role="listbox"]').first().waitFor({ state: "detached" });
			};

			// Buttons: every variant, the link as a button, IconButton.
			for (const n of [
				"Add person",
				"Commit to core group",
				"Share",
				"Export",
				"Cancel",
				"Retire",
				"Save changes",
				"Review 7 guests",
				"Small primary",
				"Small secondary",
				"Filters",
				"Not now",
			]) {
				await pointer(role("button", n), `button "${n}"`);
			}
			await pointer(role("link", "Link as a button"), 'link "Link as a button"');
			for (const n of ["More actions", "Edit", "Collapse sidebar"]) {
				await pointer(role("button", n), `icon button "${n}"`);
			}
			await pointer(role("button", "Dismiss the meeting reminder"), 'CardClose "Dismiss the meeting reminder"');
			await pointer(role("link", "Design system"), 'breadcrumb link "Design system"');

			// Disabled and loading buttons.
			await blocked(role("button", "Disabled"), 'disabled button "Disabled"');
			await blocked(role("button", "Edit (disabled)"), 'disabled icon button "Edit (disabled)"');
			await role("button", "Save changes").click();
			await expectCursor(role("button", "Saving"), "progress", 'loading button "Saving"');

			// Tabs and the segmented control.
			await pointer(role("tab", "Roles"), 'tab "Roles"');
			await blocked(role("tab", "Three"), 'disabled tab "Three"');
			await role("tab", "Three").click({ force: true });
			assert.equal(await role("tab", "Three").getAttribute("aria-selected"), "false", "disabled tab stays unselected");
			await pointer(role("radio", "List"), 'segmented item "List"');
			await blocked(role("radio", "Map"), 'disabled segmented item "Map"');
			await role("radio", "Map").click({ force: true });
			assert.equal(await role("radio", "Map").getAttribute("aria-checked"), "false", "disabled segment stays off");

			// Checkbox, Radio, Switch and their labels.
			await pointer(role("checkbox", "Send RSVP reminder"), 'checkbox "Send RSVP reminder"');
			await pointer(label("Send RSVP reminder"), 'label "Send RSVP reminder"');
			await pointer(role("radio", "Weekly"), 'radio "Weekly"');
			await pointer(label("Weekly"), 'label "Weekly"');
			await pointer(role("switch", "Daily digest"), 'switch "Daily digest"');
			await pointer(label("Daily digest"), 'label "Daily digest"');
			await blocked(role("checkbox", "Disabled checkbox"), 'disabled checkbox "Disabled checkbox"');
			await blocked(label("Disabled checkbox"), 'label "Disabled checkbox"');
			await blocked(role("radio", "Monthly"), 'disabled radio "Monthly"');
			await blocked(label("Monthly"), 'label "Monthly"');
			await blocked(role("switch", "SMS reminders"), 'disabled switch "SMS reminders"');
			await blocked(label("SMS reminders"), 'label "SMS reminders"');

			// Not too broad: text inputs, a text-input label and non-interactive surfaces.
			await expectText(role("textbox", "Full name"), 'text input "Full name"');
			await expectText(role("textbox", "Note"), 'textarea "Note"');
			await expectDefault(label("Full name"), 'text input label "Full name"');
			await expectDefault(page.locator("h1"), "heading level 1");
			await expectDefault(page.locator("h3", { hasText: "Filter chips" }), 'heading "Filter chips"');
			await expectDefault(page.locator(".ef-insight"), "InsightCard");
			await expectDefault(page.locator('section[aria-labelledby="card-core"]'), "Card");
			await expectDefault(role("region", "Recent activity"), "CardScrollArea");
			await expectDefault(page.getByText("No vision meetings yet", { exact: true }), "EmptyState title");
			await expectDefault(page.getByText("We could not load your people", { exact: true }), "StatePanel title");
			await pointer(page.getByRole("button", { name: "Try again" }).first(), 'StatePanel button "Try again"');
			await pointer(role("button", "Remove Tag filter"), 'FilterChip remove "Remove Tag filter"');

			// Menu: trigger, item, disabled item, radio items, and a trigger without asChild.
			await role("button", "More actions for Maria Santos").click();
			await pointer(loose("menuitem", "Edit profile"), 'menu item "Edit profile"');
			await blocked(loose("menuitem", "Merge duplicate"), 'disabled menu item "Merge duplicate"');
			await closeOverlay();
			const menu = role("button", "Plain menu trigger");
			await pointer(menu, 'plain MenuTrigger "Plain menu trigger"');
			await menu.click();
			await pointer(loose("menuitemradio", "Comfortable"), 'menu radio item "Comfortable"');
			await blocked(loose("menuitemradio", "Dense (disabled)"), 'disabled menu radio item "Dense (disabled)"');
			await closeOverlay();

			// DialogTrigger and PopoverTrigger without asChild; Dialog close.
			const dialogTrigger = role("button", "Plain dialog trigger");
			await pointer(dialogTrigger, 'plain DialogTrigger "Plain dialog trigger"');
			await dialogTrigger.click();
			await pointer(role("button", "Close", page.getByRole("dialog")), 'Dialog close "Close"');
			await closeOverlay();
			const popoverTrigger = role("button", "Plain popover trigger");
			await pointer(popoverTrigger, 'plain PopoverTrigger "Plain popover trigger"');
			await popoverTrigger.click();
			await closeOverlay();

			// Select: trigger, item, disabled trigger, disabled item.
			const select = role("combobox", "Stage with a disabled option");
			await pointer(select, 'select trigger "Stage with a disabled option"');
			await blocked(role("combobox", "Stage (disabled)"), 'disabled select trigger "Stage (disabled)"');
			await select.click();
			await pointer(loose("option", "Following up"), 'select item "Following up"');
			await blocked(loose("option", "Leader"), 'disabled select item "Leader"');
			await closeOverlay();

			// Combobox: trigger, item, disabled item, and the error Retry button.
			const combobox = role("combobox", "Owner with a disabled option");
			await pointer(combobox, 'combobox trigger "Owner with a disabled option"');
			await combobox.click();
			await page.getByRole("option").first().waitFor();
			const enabledOwner = page.locator('[role="option"]:not([aria-disabled="true"])').first();
			await pointer(enabledOwner, "combobox item (enabled)");
			await blocked(page.locator('[role="option"][aria-disabled="true"]'), "combobox item (disabled)");
			await closeOverlay();
			await role("combobox", "Owner that failed to load").click();
			await pointer(role("button", "Try again"), 'combobox error button "Try again"');
			await closeOverlay();

			// CommandPalette: item and the error Retry button.
			await loose("button", "Command palette").click();
			const palette = page.getByRole("dialog");
			await pointer(loose("option", "Maria Santos", palette), 'command item "Maria Santos"');
			await closeOverlay();
			await role("button", "Palette with error").click();
			await pointer(role("button", "Try again", page.getByRole("dialog")), 'command palette button "Try again"');
			await closeOverlay();

			// Sheet close.
			await role("button", "Open the guide").click();
			await pointer(role("button", "Close", page.getByRole("dialog")), 'Sheet close "Close"');
			await closeOverlay();

			// DateRangePicker: trigger, preset (a radio) and Apply.
			const range = page.getByRole("button", { name: /Date range/ });
			await pointer(range, "date range trigger");
			await range.click();
			await pointer(role("radio", "Last 7 days", page.getByRole("dialog")), 'date range preset "Last 7 days"');
			await pointer(role("button", "Apply", page.getByRole("dialog")), 'date range button "Apply"');
			await closeOverlay();

			// Toast action and close.
			await role("button", "Success toast").click();
			const toast = page.locator(".ef-toast").first();
			await pointer(role("button", "View Maria", toast), 'toast action "View Maria"');
			await pointer(role("button", "Close", toast), 'toast close "Close"');
		}),
	);

	test(`BUG-S2-T29b (${name}): the rule reaches raw buttons outside controls (AppShell)`, { timeout: 60_000 }, () =>
		withPage(engine, async (page) => {
			await page.goto(BASE + "/design/shell/owner");
			await page.locator("html[data-theme]").waitFor({ state: "attached", timeout: 60_000 });
			// These buttons carry no cursor class of their own.
			const bareButtons = await page.locator("[data-product-root] button:not(:disabled)").evaluateAll((els) =>
				els
					.filter((el) => !/\bcursor-/.test(el.className))
					.map((el) => ({
						name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
						cursor: getComputedStyle(el).cursor,
					})),
			);
			assert.ok(
				bareButtons.length >= 3,
				`Expected raw shell buttons without a cursor class, found ${bareButtons.length}.`,
			);
			for (const { name: buttonName, cursor } of bareButtons) {
				assert.equal(cursor, "pointer", `shell button "${buttonName}": cursor`);
			}
		}),
	);
}
