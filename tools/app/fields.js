(request) => {
	const text = (node) => (node ? (node.innerText ?? node.textContent ?? "") : "").trim().replace(/\s+/g, " ");
	const modal = [...document.querySelectorAll("[role=dialog],[role=alertdialog],dialog[open]")]
		.filter((node) => node.getClientRects().length)
		.pop();
	const root = modal ?? document;
	const CONTROLS = [
		"input:not([type=hidden])",
		"textarea",
		"select",
		"[contenteditable='']",
		"[contenteditable='true']",
		"[role=textbox]",
		"[role=searchbox]",
		"[role=combobox]",
		"[role=checkbox]",
		"[role=switch]",
		"[role=radio]",
	].join(",");
	const DATELIKE = ["date", "time", "datetime-local", "month", "week", "color", "range"];
	const kindOf = (el) => {
		const role = el.getAttribute("role");
		if (el.tagName === "SELECT") return "select";
		if (el.tagName === "INPUT") {
			if (["checkbox", "radio", "file", ...DATELIKE].includes(el.type)) return el.type;
			return "textbox";
		}
		if (el.tagName === "TEXTAREA") return "textbox";
		if (role === "switch" || role === "checkbox") return "checkbox";
		if (role === "radio") return "radio";
		if (role === "combobox") return "combobox";
		return "textbox";
	};
	const labelText = (label) => {
		const copy = label.cloneNode(true);
		for (const control of copy.querySelectorAll("select,textarea,input,option")) control.remove();
		return text(copy);
	};
	const labelOf = (el) => {
		const by = el.getAttribute("aria-labelledby");
		if (by) {
			const joined = by
				.split(/\s+/)
				.map((id) => text(document.getElementById(id)))
				.filter(Boolean)
				.join(" ");
			if (joined) return joined;
		}
		const aria = el.getAttribute("aria-label");
		if (aria) return aria.trim();
		const labels = el.labels ? [...el.labels].map(labelText).filter(Boolean) : [];
		if (labels.length) return labels.join(" ");
		const wrap = el.closest("label");
		if (wrap) return labelText(wrap);
		return (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").trim();
	};
	const valueOf = (el, kind) => {
		if (kind === "checkbox" || kind === "radio")
			return String(el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true");
		if (kind === "select") return el.selectedOptions[0] ? el.selectedOptions[0].label.trim() : "";
		if (kind === "file") return [...el.files].map((file) => file.name).join(", ");
		if (kind === "combobox" && el.tagName !== "INPUT") return text(el);
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value;
		return text(el);
	};
	const pathOf = (el) => {
		const parts = [];
		for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
			let step = node.tagName.toLowerCase();
			if (node.id) {
				parts.unshift(`#${CSS.escape(node.id)}`);
				break;
			}
			const same = node.parentElement
				? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
				: [];
			if (same.length > 1) step += `:nth-of-type(${same.indexOf(node) + 1})`;
			parts.unshift(step);
		}
		return parts.join(" > ");
	};
	const usable = (el) => {
		if (el.closest("[aria-hidden=true],[inert]")) return false;
		if (el.tagName === "INPUT" && ["checkbox", "radio", "file"].includes(el.type)) return true;
		return el.getClientRects().length > 0;
	};
	if (request.op === "list")
		return JSON.stringify(
			[...root.querySelectorAll(CONTROLS)].filter(usable).map((el) => {
				const kind = kindOf(el);
				return { selector: pathOf(el), kind, label: labelOf(el), value: valueOf(el, kind) };
			}),
		);
	const el = document.querySelector(request.selector);
	if (!el) return JSON.stringify({ missing: true });
	if (request.op === "set") {
		const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(el, request.value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}
	return JSON.stringify({ value: valueOf(el, request.kind), alt: el.value ?? "" });
};
