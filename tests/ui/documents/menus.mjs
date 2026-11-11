// Closing an editor toolbar menu or popover with Escape. Radix hands focus back to the button that opened it in a timer
// after the overlay unmounts, so a step that focuses the document right after the overlay detaches can lose focus to
// that button a moment later. These wait for focus to land on the button before moving on.

/** Escape closes the open toolbar menu; resolves once focus is back on a menu button. */
export const closeMenu = async (page) => {
	await page.keyboard.press("Escape");
	await page.getByRole("menu").waitFor({ state: "detached" });
	await page.waitForFunction(() => {
		const el = document.activeElement;
		return el?.getAttribute("aria-haspopup") === "menu" && el.getAttribute("aria-expanded") === "false";
	});
};

/** Escape closes the open menu or popover; resolves once focus is on the button labelled `opener`. */
export const escapeTo = async (page, opener) => {
	await page.keyboard.press("Escape");
	await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, opener);
};
