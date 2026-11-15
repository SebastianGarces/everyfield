(needle) => {
	const matches = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const at = node.data.indexOf(needle);
		if (at < 0 || !node.parentElement) continue;
		const range = document.createRange();
		range.setStart(node, at);
		range.setEnd(node, at + needle.length);
		matches.push({ el: node.parentElement, rects: [...range.getClientRects()] });
	}
	if (!matches.length)
		for (const el of document.body.querySelectorAll("*")) {
			if (!(el.textContent || "").includes(needle)) continue;
			if ([...el.children].some((child) => (child.textContent || "").includes(needle))) continue;
			matches.push({ el, rects: [...el.getClientRects()] });
		}
	const inTree = (el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest("[aria-hidden=true]");
	const clipped = (el, rect) => {
		for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (
				style.overflowX === "visible" &&
				style.overflowY === "visible" &&
				style.clipPath === "none" &&
				style.clip === "auto"
			)
				continue;
			const box = node.getBoundingClientRect();
			const width = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
			const height = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
			if (width <= 1 || height <= 1 || style.clip.startsWith("rect(0")) return true;
		}
		return false;
	};
	const covered = (el, rect) => {
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
		const hit = document.elementFromPoint(x, y);
		return !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
	};
	const transparent = (el) => {
		for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return true;
		return false;
	};
	const seen = (match) =>
		match.el.checkVisibility({ visibilityProperty: true }) &&
		!transparent(match.el) &&
		match.rects.some(
			(rect) => rect.width > 1 && rect.height > 1 && !clipped(match.el, rect) && !covered(match.el, rect),
		);
	if (matches.some(seen)) return "visible";
	if (matches.some((match) => inTree(match.el))) return "screen-reader";
	return "absent";
};
