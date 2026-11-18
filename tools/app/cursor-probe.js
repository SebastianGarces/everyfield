(scope) => {
	const CLICK_ROLES = [
		"button",
		"link",
		"tab",
		"menuitem",
		"menuitemcheckbox",
		"menuitemradio",
		"option",
		"checkbox",
		"radio",
		"switch",
		"treeitem",
	];
	const SEMANTIC = [
		"a[href]",
		"area[href]",
		"button",
		"summary",
		"select",
		'input:is([type="checkbox"],[type="radio"],[type="file"],[type="range"],[type="color"],[type="submit"],[type="reset"],[type="button"],[type="image"])',
		'label:has(input:is([type="checkbox"],[type="radio"],[type="file"]),[role="checkbox"],[role="radio"],[role="switch"])',
		"label[data-toggle-label]",
		...CLICK_ROLES.map((role) => `[role="${role}"]`),
	].join(",");
	const EXCEPTIONS = { '[aria-roledescription="carousel"]': ["grab", "grabbing"] };
	const HANDLERS = ["onClick", "onMouseDown", "onPointerDown", "onMouseUp", "onPointerUp", "onDoubleClick"];
	const reactProps = (el) => {
		for (const key in el) if (key.startsWith("__reactProps$")) return el[key];
		return null;
	};
	const handlerOf = (el) => {
		const props = reactProps(el);
		if (props) for (const handler of HANDLERS) if (typeof props[handler] === "function") return handler;
		return typeof el.onclick === "function" ? "onclick" : null;
	};
	const disabledOf = (el) =>
		el.matches(":disabled") ||
		el.getAttribute("aria-disabled") === "true" ||
		(el.hasAttribute("data-disabled") && el.getAttribute("data-disabled") !== "false") ||
		(el.tagName === "LABEL" &&
			(!!el.querySelector("input:disabled, button:disabled, [data-disabled]:not([data-disabled=false])") ||
				el.control?.disabled === true));
	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 1 || rect.height <= 1) return false;
		const style = getComputedStyle(el);
		return (
			style.visibility === "visible" &&
			style.display !== "none" &&
			style.pointerEvents !== "none" &&
			!el.closest("[inert]")
		);
	};
	const nameOf = (el) =>
		(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
	const root = scope ? document.querySelector(scope) : document;
	if (!root) return JSON.stringify({ missing: scope });
	const all = [];
	const walk = (node) => {
		for (const el of node.querySelectorAll("*")) {
			if (el.tagName === "NEXTJS-PORTAL") continue;
			all.push(el);
			if (el.shadowRoot) walk(el.shadowRoot);
		}
	};
	walk(root);
	const violations = [];
	let checked = 0;
	for (const el of all) {
		const semantic = el.matches(SEMANTIC);
		const handler = handlerOf(el);
		if ((!semantic && !handler) || !visible(el) || el.matches('[role="dialog"][tabindex]')) continue;
		checked++;
		const cursor = getComputedStyle(el).cursor;
		const rect = el.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		const hitCursor = hit && el.contains(hit) ? getComputedStyle(hit).cursor : null;
		const allowed = new Set(disabledOf(el) ? ["not-allowed"] : ["pointer"]);
		if (el.closest('[aria-busy="true"]')) allowed.add("progress").add("wait");
		if (el.getAttribute("draggable") === "true" || el.closest('[draggable="true"]'))
			allowed.add("grab").add("grabbing");
		if (el.closest('[contenteditable="true"]')) allowed.add("text").add("auto");
		if (!semantic && el.getAttribute("role") === "presentation" && el.querySelector("input,textarea"))
			allowed.add("text");
		for (const [selector, extra] of Object.entries(EXCEPTIONS))
			if (el.matches(selector)) for (const value of extra) allowed.add(value);
		if (!allowed.has(cursor) || (hitCursor && !allowed.has(hitCursor) && hitCursor !== "text"))
			violations.push({
				role: el.getAttribute("role") || el.tagName.toLowerCase(),
				name: nameOf(el),
				cursor,
				hitCursor: hitCursor !== cursor ? hitCursor : null,
				expected: [...allowed].join("|"),
			});
	}
	return JSON.stringify({ checked, violations });
};
