// The prototype shell: library, page setup, fields, editor, paged preview, fork, wipe and export.
// Everything loads from the origin that serves this folder; nothing is fetched from anywhere else.
import { PAGE_PRESETS, pageBox } from "../format/model.mjs";
import { blank, fingerprint, fork, wipe } from "../format/ops.mjs";
import { validateDocument } from "../format/validator.mjs";
import { format, insertAtom, renderEditor } from "./editor.mjs";
import { esc, onColor, renderPages, tones } from "./render.mjs";

const EXAMPLES = ["conflict-of-interest-policy", "commitment-card", "guest-sign-in-sheet", "first-year-budget"];
const $ = (sel) => document.querySelector(sel);
const PT_PER_IN = 72;

const state = {
	schema: null,
	templates: [], // { doc, loadedPrint }
	docs: [],
	current: null, // { kind: "template" | "document", index }
	brandOn: true,
	selected: null,
	wipeArmed: false,
	nextDoc: 1,
	lastExport: null,
};
const currentDoc = () =>
	state.current ? (state.current.kind === "template" ? state.templates[state.current.index].doc : state.docs[state.current.index]) : null;
const readOnly = () => state.current?.kind === "template";

// ---------- status and header

function updateStatus() {
	const doc = currentDoc();
	const errors = validateDocument(doc, state.schema);
	const chip = $("#status");
	chip.className = `status ${errors.length ? "is-bad" : "is-good"}`;
	$("#status-text").textContent = errors.length ? `${errors.length} problem${errors.length === 1 ? "" : "s"}` : "Valid format";
	$("#status-list").innerHTML = errors.length
		? errors.map((e) => `<li><code>${esc(e)}</code></li>`).join("")
		: "<li>The document passes format/schema.json and the cross-reference rules.</li>";
	return errors;
}

function renderHeader() {
	const doc = currentDoc();
	const tpl = readOnly();
	$("#doc-title").value = doc.title;
	$("#doc-title").readOnly = tpl;
	$("#doc-kind").textContent = tpl ? `Template · v${doc.version}` : "Document";
	$("#fork").hidden = !tpl;
	$("#wipe").hidden = tpl;
	$("#wipe").textContent = state.wipeArmed ? "Confirm wipe" : "Wipe document";
	$("#wipe").classList.toggle("is-armed", state.wipeArmed);
	$("#wipe-cancel").hidden = tpl || !state.wipeArmed;
	const banner = $("#banner");
	if (tpl) {
		const entry = state.templates[state.current.index];
		const now = fingerprint(entry.doc);
		banner.className = "banner is-template";
		banner.innerHTML = `<strong>Template, read only.</strong> Use it to make your own document; the copy is yours to change or wipe. <span class="fp">Fingerprint <code id="tpl-fp">${now}</code> ${
			now === entry.loadedPrint ? '<span class="fp-ok">unchanged since load</span>' : '<span class="fp-bad">changed</span>'
		}</span>`;
	} else {
		banner.className = "banner is-doc";
		const from = doc.origin
			? `Made from template <strong>${esc(doc.origin.templateId)}</strong> v${doc.origin.templateVersion}${doc.origin.forkedFrom ? `, through ${esc(doc.origin.forkedFrom)}` : ""}. It never follows later template changes.`
			: "A blank document. No template is behind it.";
		const notice = doc.notices.includes("template-not-legal-advice")
			? ' <span class="lock">Required notice: “Template, not legal advice” prints on every page. A wipe keeps it.</span>'
			: "";
		banner.innerHTML = `${from}${notice}`;
	}
	$("#toolbar").hidden = tpl;
	updateStatus();
}

// ---------- library

function renderLibrary() {
	const item = (kind, index, doc, meta) => {
		const on = state.current?.kind === kind && state.current.index === index;
		return `<li><button type="button" class="lib-item${on ? " is-on" : ""}" data-kind="${kind}" data-index="${index}" aria-current="${on}"><span class="lib-title">${esc(doc.title)}</span><span class="lib-meta">${esc(meta)}</span></button></li>`;
	};
	$("#lib-templates").innerHTML = state.templates
		.map((t, i) => item("template", i, t.doc, `Template v${t.doc.version} · ${t.doc.class}`))
		.join("");
	$("#lib-docs").innerHTML = state.docs.length
		? state.docs.map((d, i) => item("document", i, d, d.origin ? `From ${d.origin.templateId}` : "Blank document")).join("")
		: '<li class="lib-empty">No documents yet. Use a template or start empty.</li>';
}

function open(kind, index) {
	state.current = { kind, index };
	state.selected = null;
	state.wipeArmed = false;
	renderAll();
}

// ---------- page setup

const inches = (pt) => Math.round((pt / PT_PER_IN) * 100) / 100;
function renderSetup() {
	const doc = currentDoc();
	const p = doc.page;
	const off = readOnly();
	const box = pageBox(p);
	const imp = p.imposition;
	$("#setup").innerHTML = `
		<label class="field"><span>Page size</span>
			<select id="pg-size" ${off ? "disabled" : ""}>${Object.entries(PAGE_PRESETS)
				.map(([k, v]) => `<option value="${k}" ${p.size === k ? "selected" : ""}>${v.label}</option>`)
				.join("")}<option value="custom" ${p.size === "custom" ? "selected" : ""}>Custom size</option></select></label>
		${p.size === "custom" ? `<div class="pair"><label class="field"><span>Width (in)</span><input id="pg-w" type="number" step="0.05" min="1" value="${inches(p.width)}" ${off ? "disabled" : ""}></label><label class="field"><span>Height (in)</span><input id="pg-h" type="number" step="0.05" min="1" value="${inches(p.height)}" ${off ? "disabled" : ""}></label></div>` : ""}
		<fieldset class="seg" ${off ? "disabled" : ""}><legend>Orientation</legend>
			<label><input type="radio" name="pg-or" value="portrait" ${p.orientation === "portrait" ? "checked" : ""}><span>Portrait</span></label>
			<label><input type="radio" name="pg-or" value="landscape" ${p.orientation === "landscape" ? "checked" : ""}><span>Landscape</span></label>
		</fieldset>
		<fieldset class="margins" ${off ? "disabled" : ""}><legend>Margins (in)</legend>
			${["top", "right", "bottom", "left"].map((side) => `<label class="field"><span>${side[0].toUpperCase() + side.slice(1)}</span><input type="number" data-margin="${side}" step="0.05" min="0" max="3" value="${inches(p.margins[side])}"></label>`).join("")}
		</fieldset>
		<fieldset class="impose" ${off ? "disabled" : ""}><legend>Print several on one sheet</legend>
			<label class="check"><input type="checkbox" id="imp-on" ${imp ? "checked" : ""}><span>Impose copies on a sheet</span></label>
			${imp ? `<div class="pair">
				<label class="field"><span>Sheet</span><select id="imp-sheet">${["letter", "legal", "a4"].map((s) => `<option value="${s}" ${imp.sheet === s ? "selected" : ""}>${PAGE_PRESETS[s].label}</option>`).join("")}</select></label>
				<label class="field"><span>Across</span><input id="imp-across" type="number" min="1" max="4" value="${imp.across}"></label>
				<label class="field"><span>Down</span><input id="imp-down" type="number" min="1" max="4" value="${imp.down}"></label>
			</div>
			<label class="check"><input type="checkbox" id="imp-cuts" ${imp.cutMarks ? "checked" : ""}><span>Cut lines</span></label>` : ""}
		</fieldset>
		<p class="hint">Trim page ${inches(box.width)} × ${inches(box.height)} in.${imp ? ` ${imp.across * imp.down} copies on each ${imp.sheet} sheet.` : ""}</p>`;
	if (off) return;
	const changed = () => (renderSetup(), structural());
	$("#pg-size").onchange = (e) => {
		p.size = e.target.value;
		if (p.size === "custom") Object.assign(p, { width: box.width, height: box.height });
		else {
			delete p.width;
			delete p.height;
		}
		changed();
	};
	if ($("#pg-w")) $("#pg-w").onchange = (e) => ((p.width = Math.round(Number(e.target.value) * PT_PER_IN)), changed());
	if ($("#pg-h")) $("#pg-h").onchange = (e) => ((p.height = Math.round(Number(e.target.value) * PT_PER_IN)), changed());
	document.querySelectorAll('input[name="pg-or"]').forEach((r) => (r.onchange = (e) => ((p.orientation = e.target.value), changed())));
	document.querySelectorAll("[data-margin]").forEach(
		(input) => (input.onchange = (e) => ((p.margins[e.target.dataset.margin] = Math.round(Number(e.target.value) * PT_PER_IN * 10) / 10), changed())),
	);
	$("#imp-on").onchange = (e) => ((p.imposition = e.target.checked ? { sheet: "letter", across: 2, down: 2, cutMarks: true } : null), changed());
	if (imp) {
		$("#imp-sheet").onchange = (e) => ((imp.sheet = e.target.value), changed());
		$("#imp-across").onchange = (e) => ((imp.across = Math.min(4, Math.max(1, Number(e.target.value) || 1))), changed());
		$("#imp-down").onchange = (e) => ((imp.down = Math.min(4, Math.max(1, Number(e.target.value) || 1))), changed());
		$("#imp-cuts").onchange = (e) => ((imp.cutMarks = e.target.checked), changed());
	}
}

// ---------- fields

const keyOf = (label, doc) => {
	const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1") || "field";
	let key = base;
	for (let n = 2; doc.fields.some((f) => f.key === key); n++) key = `${base}_${n}`;
	return key;
};
function renderFields() {
	const doc = currentDoc();
	const off = readOnly();
	$("#fields").innerHTML = `${
		doc.fields.length
			? `<ul class="fields">${doc.fields
					.map(
						(f, i) => `<li><label class="field"><span>${esc(f.label)} <code>${esc(f.key)}</code>${f.source ? ` <em>fills from ${esc(f.source)}</em>` : ""}</span>
						<input data-field="${i}" type="text" value="${esc(f.value ?? "")}" placeholder="Empty: prints [${esc(f.label.toLowerCase())}]" ${off ? "disabled" : ""}></label>
						${off ? "" : `<button type="button" class="btn-mini" data-remove-field="${i}" aria-label="Remove field ${esc(f.label)}">✕</button>`}</li>`,
					)
					.join("")}</ul>`
			: '<p class="hint">No fields. A field is a value the app fills in, like the church name.</p>'
	}
	${off ? "" : `<form id="add-field" class="pair"><label class="field"><span>New field</span><input id="nf-label" type="text" placeholder="Label, for example Event date" required></label><label class="field"><span>Type</span><select id="nf-type">${["text", "date", "number", "email", "phone"].map((t) => `<option>${t}</option>`).join("")}</select></label><button type="submit" class="btn">Add field</button></form>`}`;
	$("#tb-field").innerHTML = `<option value="">Insert field…</option>${doc.fields.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join("")}`;
	if (off) return;
	document.querySelectorAll("[data-field]").forEach(
		(input) =>
			(input.oninput = (e) => {
				doc.fields[Number(e.target.dataset.field)].value = e.target.value || null;
				refreshFieldAtoms();
				content();
			}),
	);
	document.querySelectorAll("[data-remove-field]").forEach(
		(b) => (b.onclick = () => (doc.fields.splice(Number(b.dataset.removeField), 1), renderFields(), structural())),
	);
	$("#add-field").onsubmit = (e) => {
		e.preventDefault();
		const label = $("#nf-label").value.trim();
		if (!label) return;
		doc.fields.push({ key: keyOf(label, doc), label, type: $("#nf-type").value, source: null, value: null });
		renderFields();
		updateStatus();
	};
}
/** Field atoms in the editor show the new value without a re-render, so the caret stays put. */
function refreshFieldAtoms() {
	const doc = currentDoc();
	for (const atom of document.querySelectorAll('#editor [data-inline="field"]')) {
		const f = doc.fields.find((x) => x.key === atom.dataset.key);
		atom.textContent = f?.value || `[${(f?.label ?? atom.dataset.key).toLowerCase()}]`;
		atom.classList.toggle("is-empty", !f?.value);
	}
}

// ---------- editor and preview

/** Puts the caret at the end of a text. The editor renders synchronously, so the new block is already there. */
function focusIn(selector, which = 0) {
	const node = document.querySelectorAll(selector)[which];
	if (!node) return;
	node.focus();
	const sel = document.getSelection();
	const r = document.createRange();
	r.selectNodeContents(node);
	r.collapse(false);
	sel.removeAllRanges();
	sel.addRange(r);
}
function renderEditorPanel() {
	const doc = currentDoc();
	const box = pageBox(doc.page);
	const host = $("#editor");
	host.style.setProperty("--content-w", `${box.width - doc.page.margins.left - doc.page.margins.right}px`);
	host.classList.toggle("is-small", box.width < 420);
	renderEditor(host, doc, {
		readOnly: readOnly(),
		tones: tones(state.brandOn),
		brandOn: state.brandOn,
		onColor,
		selected: state.selected,
		select: (id) => (state.selected = id),
		changed: (isStructural) => (isStructural ? structural() : content()),
		focus: (id) => focusIn(`.blk[data-id="${id}"] [data-editable]`),
		focusItem: (id, i) => focusIn(`.blk[data-id="${id}"] li [data-editable]`, i),
	});
}

let previewTimer = 0;
function schedulePreview() {
	clearTimeout(previewTimer);
	previewTimer = setTimeout(renderPreview, 120);
}
function renderPreview() {
	const doc = currentDoc();
	const host = $("#preview");
	const result = renderPages(doc, { tones: tones(state.brandOn), brandOn: state.brandOn }, $("#measure"));
	const avail = Math.max(200, $("#preview-panel").clientWidth - 40);
	const widest = Math.max(...result.sheets.map((s) => s.width), 1);
	const scale = Math.min(1, avail / widest);
	host.innerHTML = result.error
		? `<p class="pv-error">${esc(result.error)}</p>`
		: result.sheets
				.map(
					(s, i) =>
						`<figure class="pv-sheet" aria-label="Sheet ${i + 1} of ${result.sheets.length}"><div class="pv-frame" style="width:${s.width * scale}px;height:${s.height * scale}px"><div class="pv-scale" style="transform:scale(${scale})">${s.html}</div></div><figcaption>Sheet ${i + 1} of ${result.sheets.length}</figcaption></figure>`,
				)
				.join("");
	const box = pageBox(doc.page);
	$("#pv-meta").textContent = `${result.pages} page${result.pages === 1 ? "" : "s"} · ${inches(box.width)} × ${inches(box.height)} in ${doc.page.orientation}${
		doc.page.imposition && result.sheet ? ` · ${doc.page.imposition.across * doc.page.imposition.down}-up on ${doc.page.imposition.sheet}` : ""
	}`;
}

function structural() {
	renderEditorPanel();
	content();
}
function content() {
	updateStatus();
	schedulePreview();
	renderLibrary();
}
function renderAll() {
	renderLibrary();
	renderHeader();
	renderSetup();
	renderFields();
	renderEditorPanel();
	renderPreview();
}

// ---------- actions

function exportJSON() {
	const doc = currentDoc();
	const json = `${JSON.stringify(doc, null, "\t")}\n`;
	state.lastExport = json;
	const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
	const a = Object.assign(document.createElement("a"), { href: url, download: `${doc.id}.json` });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	const errors = updateStatus();
	$("#export-note").textContent = errors.length ? `Exported ${doc.id}.json with ${errors.length} problems.` : `Exported ${doc.id}.json. It passes the format check.`;
}

function bind() {
	document.addEventListener("click", (e) => {
		const lib = e.target.closest(".lib-item");
		if (lib) {
			open(lib.dataset.kind, Number(lib.dataset.index));
			if (window.matchMedia("(max-width: 1099px)").matches) setTab("edit");
		}
		if (!e.target.closest(".ins")) document.querySelectorAll(".ins-menu").forEach((m) => (m.hidden = true));
	});
	$("#fork").onclick = () => {
		const doc = fork(currentDoc(), `doc-${state.nextDoc++}`);
		state.docs.push(doc);
		open("document", state.docs.length - 1);
	};
	$("#new-doc").onclick = () => {
		state.docs.push(blank(`doc-${state.nextDoc++}`));
		open("document", state.docs.length - 1);
		if (window.matchMedia("(max-width: 1099px)").matches) setTab("edit");
	};
	$("#wipe").onclick = () => {
		if (!state.wipeArmed) {
			state.wipeArmed = true;
			renderHeader();
			return;
		}
		state.docs[state.current.index] = wipe(currentDoc());
		state.wipeArmed = false;
		renderAll();
	};
	$("#wipe-cancel").onclick = () => ((state.wipeArmed = false), renderHeader());
	$("#export").onclick = exportJSON;
	$("#doc-title").oninput = (e) => {
		if (readOnly()) return;
		currentDoc().title = e.target.value || "Untitled document";
		content();
	};
	$("#brand").onchange = (e) => {
		state.brandOn = e.target.checked;
		renderEditorPanel();
		renderPreview();
	};
	const toolbar = $("#toolbar");
	toolbar.addEventListener("mousedown", (e) => {
		if (e.target.closest("button")) e.preventDefault();
	});
	toolbar.querySelectorAll("[data-cmd]").forEach((b) => (b.onclick = () => format(b.dataset.cmd)));
	$("#tb-link").onclick = () => {
		const href = $("#tb-value").value.trim();
		if (/^(https?:\/\/|mailto:|tel:)/.test(href)) format("createLink", href);
		else $("#tb-value").focus();
	};
	const atom = (html) => insertAtom(html) || ($("#export-note").textContent = "Click in a text first, then insert.");
	$("#tb-field").onchange = (e) => {
		const key = e.target.value;
		e.target.value = "";
		if (!key) return;
		const f = currentDoc().fields.find((x) => x.key === key);
		atom(`<span class="i-field${f.value ? "" : " is-empty"}" data-inline="field" data-key="${esc(key)}" contenteditable="false">${esc(f.value || `[${f.label.toLowerCase()}]`)}</span>`);
	};
	$("#tb-prompt").onclick = () => {
		const text = $("#tb-value").value.trim() || "fill in";
		atom(`<span class="i-prompt" data-inline="prompt" data-text="${esc(text)}" contenteditable="false">[${esc(text)}]</span>`);
	};
	$("#tb-badge").onclick = () => {
		const text = ($("#tb-value").value.trim() || "NEW").slice(0, 24).toUpperCase();
		const bg = tones(state.brandOn).accent;
		atom(`<span class="i-badge" data-inline="badge" data-text="${esc(text)}" data-tone="accent" contenteditable="false" style="background:${bg};color:${onColor(bg)}">${esc(text)}</span>`);
	};
	$("#tb-page").onclick = () => atom(`<span class="i-page" data-inline="pageNumber" contenteditable="false">Page 1 of 1</span>`);
	document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
	let resize = 0;
	window.addEventListener("resize", () => (clearTimeout(resize), (resize = setTimeout(renderPreview, 150))));
}
function setTab(tab) {
	document.body.dataset.tab = tab;
	document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
	if (tab === "preview") renderPreview();
}

async function main() {
	const base = new URL("../", import.meta.url);
	state.schema = await (await fetch(new URL("format/schema.json", base))).json();
	for (const id of EXAMPLES) {
		const doc = await (await fetch(new URL(`examples/${id}.json`, base))).json();
		state.templates.push({ doc, loadedPrint: fingerprint(doc) });
	}
	bind();
	const wanted = new URLSearchParams(location.search).get("open");
	open("template", Math.max(0, EXAMPLES.indexOf(wanted)));
	setTab("edit");
	// Read-only hooks for scripted checks: the current document, the last export and the template fingerprints.
	window.evfPrototype = {
		current: () => JSON.parse(JSON.stringify(currentDoc())),
		lastExport: () => state.lastExport,
		templateFingerprints: () => state.templates.map((t) => ({ id: t.doc.id, loaded: t.loadedPrint, now: fingerprint(t.doc) })),
		validate: () => validateDocument(currentDoc(), state.schema),
	};
	document.body.classList.add("is-ready");
}
main().catch((error) => {
	document.body.innerHTML = `<p class="pv-error">The prototype could not load: ${esc(error.message)}. Serve the approach-b folder over HTTP; see README.md.</p>`;
});
