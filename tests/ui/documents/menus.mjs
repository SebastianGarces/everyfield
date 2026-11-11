// Closing an editor toolbar menu with Escape. Radix hands focus back to the menu's button in a timer after the menu
// unmounts, so a step that focuses the document right after the menu detaches can lose focus to that button a moment
// later. Wait for focus to land on the button before moving on.
export const closeMenu = async (page) => {
	await page.keyboard.press("Escape");
	await page.getByRole("menu").waitFor({ state: "detached" });
	await page.waitForFunction(() => {
		const el = document.activeElement;
		return el?.getAttribute("aria-haspopup") === "menu" && el.getAttribute("aria-expanded") === "false";
	});
};
