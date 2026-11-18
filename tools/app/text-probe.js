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
	const fixedClip = (value) => value === "hidden" || value === "clip";
	const ancestors = (el) => {
		const list = [];
		for (let node = el; node && node !== document.documentElement && node !== document.body; node = node.parentElement)
			list.push(node);
		return list;
	};
	const clipped = (el, rect) =>
		ancestors(el).some((node) => {
			const style = getComputedStyle(node);
			const clipAll = style.clip !== "auto" || style.clipPath !== "none";
			const clipX = clipAll || fixedClip(style.overflowX);
			const clipY = clipAll || fixedClip(style.overflowY);
			if (!clipX && !clipY) return false;
			if (style.clip.startsWith("rect(0")) return true;
			const box = node.getBoundingClientRect();
			const width = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
			const height = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
			return (clipX && width <= 1) || (clipY && height <= 1);
		});
	const inView = (el, rect) => {
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
		return ancestors(el.parentElement).every((node) => {
			const box = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			if (style.overflowX === "visible" && style.overflowY === "visible") return true;
			return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
		});
	};
	const covered = (el, rect) => {
		if (!inView(el, rect)) return false;
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		return !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
	};
	const transparent = (el) => ancestors(el).some((node) => Number(getComputedStyle(node).opacity) === 0);
	const why = (match) => {
		if (!match.el.checkVisibility({ visibilityProperty: true })) return "hidden";
		if (transparent(match.el)) return "transparent";
		const sized = match.rects.filter((rect) => rect.width > 1 && rect.height > 1);
		if (!sized.length) return "zero size";
		const open = sized.filter((rect) => !clipped(match.el, rect));
		if (!open.length) return "clipped";
		if (open.every((rect) => covered(match.el, rect))) return "covered";
		return "";
	};
	const judged = matches.map((match) => ({
		reason: why(match),
		inTree: match.el.checkVisibility({ visibilityProperty: true }) && !match.el.closest("[aria-hidden=true]"),
	}));
	if (judged.some((match) => !match.reason)) return JSON.stringify({ state: "visible" });
	const told = judged.find((match) => match.inTree);
	if (told) return JSON.stringify({ state: "screen-reader", reason: told.reason });
	if (judged.length) return JSON.stringify({ state: "hidden", reason: judged[0].reason });
	return JSON.stringify({ state: "absent" });
};
