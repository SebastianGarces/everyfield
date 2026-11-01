// WP-097: the landing kit EvryBot on / is the approved Evry (OPS-84) from @everyfield/ui/foundations. The three bots are
// the hero's (lg, its mood follows the hero clock), the Monday overview card's (sm) and the journey walker (lg). The
// checks read what the life loop writes: the body and eye paths, the group transform and the inner bot's data-shape,
// data-act and data-blink. Every run seeds Math.random in an init script; the timing checks also run on Playwright's
// clock, so they step the same simulated time each run.
//   SSR: the server renders the full SVG (a circle with rest eyes, no mouth); hydration logs no warning (Done 3, 4).
//   Morph and acts: the hero morphs; over 60 s of simulated time every two morph starts have an act start between them
//     and each morph goes to another shape (Done 5, 9).
//   Look: during an idle look act the hero's eyes narrow and stay 3.5 units inside the body path (Done 7, 8).
//   Rest eyes: 0.11 x 0.23 of the size in ink, no white dot, blinks shut them (Done 6, 8).
//   Moods: data-mood drives happy (arches, bounce, no blink) and thinking (rigid eyes up and right, the dot at lg only);
//     talking renders as idle (Done 11).
//   Reduced motion: still circles; the preference applies without a reload (Done 13).
//   Offscreen: with no bot on screen nothing changes and no frame runs (Done 14).
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/marketing/evry-bot.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { edges, margin, newEdges, restPaths, SHAPES } from "../../../packages/ui/src/foundations/evry-geo.ts";
import { BASE, ENGINES } from "../setup.mjs";

const HERO = "#top [data-evry-bot]";
const MONDAY = '[data-evry-bot][data-size="sm"]';
const WALKER = '[data-evry-bot][data-size="lg"]:not(#top *)';
const BOTS = [HERO, MONDAY, WALKER];
const INK = "rgb(24, 29, 25)";

/** A seeded Math.random (mulberry32), installed before any page script runs. */
const seeded = () => {
	let s = 0x2f6b1d;
	Math.random = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Opens / in `engine` with motion allowed (unless `reduced`), a seeded Math.random and, with `clock`, a fake clock. */
async function withHome(engine, run, { reduced = false, width = 1440, init, clock = false } = {}) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({
			viewport: { width, height: 900 },
			reducedMotion: reduced ? "reduce" : "no-preference",
			ignoreHTTPSErrors: true,
		});
		await context.addInitScript(seeded);
		if (init) await context.addInitScript(init);
		const page = await context.newPage();
		if (clock) await page.clock.install();
		const logs = [];
		page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
		page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
		await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 120_000 });
		for (const s of BOTS) await page.locator(`${s} .evry-bot[data-eb]`).waitFor({ state: "attached", timeout: 60_000 });
		await run(page, logs);
	} finally {
		await browser.close();
	}
}

/** Stops the hero clock (its pause button), so the scene never changes the hero bot's mood. */
const pauseHero = (page) => page.locator("#top").getByRole("button", { name: "Pause animation" }).click();

/** Pauses the page clock now; `step(ms)` then advances simulated time. */
async function freeze(page) {
	const t = await page.evaluate(() => Date.now());
	await page.clock.pauseAt(t + 50);
	return (ms) => page.clock.runFor(ms);
}

const pairs = (d) => {
	const n = d.match(/-?\d+(\.\d+)?/g).map(Number);
	return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]]);
};
/** The body path's 36 outline points: the Q control point, then each T's reflected control point. */
function outline(d) {
	const p = pairs(d);
	const P = [p[1]];
	let end = p[2];
	for (let i = 3; i < p.length; i++) {
		const c = P.at(-1);
		P.push([2 * end[0] - c[0], 2 * end[1] - c[1]]);
		end = p[i];
	}
	return Float64Array.from(P.slice(0, 36).flat());
}
/** The narrowest width of an eye's control points over 180 directions. */
function eyeWidth(d) {
	const p = pairs(d);
	let w = Infinity;
	for (let a = 0; a < 180; a++) {
		const c = Math.cos((a * Math.PI) / 180);
		const s = Math.sin((a * Math.PI) / 180);
		const proj = p.map(([x, y]) => x * c + y * s);
		w = Math.min(w, Math.max(...proj) - Math.min(...proj));
	}
	return w;
}
const centre = (d) => {
	const p = pairs(d);
	return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
};

/** The drawn state of the bot at `selector`. */
const read = (page, selector) =>
	page.locator(selector).evaluate((root) => {
		const el = root.querySelector(".evry-bot");
		return {
			body: el.querySelector("defs path").getAttribute("d"),
			eyes: [...el.querySelectorAll(".eb-e")].map((e) => e.getAttribute("d")),
			g: el.querySelector(".eb-g").getAttribute("transform") ?? "",
			hl: el.querySelector("radialGradient").getAttribute("gradientTransform") ?? "",
			sh: el.querySelector("linearGradient").getAttribute("gradientTransform") ?? "",
			shape: el.dataset.shape,
			act: el.dataset.act ?? null,
			mood: el.dataset.mood,
		};
	});
/** The drawn paths and transform of every bot on the page. */
const snapshot = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll("[data-evry-bot]")].map(
			(el) =>
				el.querySelector("defs path").getAttribute("d") +
				[...el.querySelectorAll(".eb-e")].map((e) => e.getAttribute("d")).join("") +
				(el.querySelector(".eb-g").getAttribute("transform") ?? ""),
		),
	);

/** Waits until `check` returns a truthy value, polling every 50 ms, or fails after `ms`. */
async function until(check, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await check();
		if (v) return v;
		assert.ok(Date.now() < end, `timed out after ${ms} ms: ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

for (const [name, engine] of ENGINES) {
	test(`WP-097 Evry SSR (${name}): full SVG, a circle with rest eyes, no mouth, no hydration warning`, () =>
		withHome(engine, async (page, logs) => {
			const html = await (await page.request.get(BASE + "/")).text();
			const bots = html.match(/<span[^>]*data-evry-bot=""[^>]*>.*?<\/svg><\/span><\/span><\/span>/g) ?? [];
			assert.equal(bots.length, 3, "three bots on /");
			const rest = restPaths("circle", "idle");
			const ids = new Set();
			for (const bot of bots) {
				assert.match(bot, /aria-hidden="true"/);
				assert.match(bot, /data-size="(sm|lg)"/);
				assert.match(bot, /data-mood="idle"/);
				assert.match(bot, /class="evry-bot"[^>]*data-shape="circle"/);
				assert.match(bot, /<svg viewBox="0 0 100 100"/);
				assert.ok(bot.includes(`d="${rest.body}"`), "circle body");
				for (const eye of rest.eyes) assert.ok(bot.includes(`d="${eye}"`), "rest eyes");
				// One body path in defs drawn three times (fill, shade, highlight) and two eye paths: no mouth.
				assert.equal(bot.match(/<path/g).length, 3);
				assert.equal(bot.match(/<use/g).length, 3);
				assert.equal(bot.match(/class="eb-e"/g).length, 2);
				assert.match(bot, /<use href="#(eb[\w-]+)p" class="eb-fill"/);
				assert.match(bot, /fill="url\(#eb[\w-]+s\)"/);
				assert.match(bot, /fill="url\(#eb[\w-]+h\)"/);
				for (const [, id] of bot.matchAll(/ id="([^"]+)"/g)) {
					assert.ok(!ids.has(id), `unique id ${id}`);
					ids.add(id);
				}
			}
			// The float period is set after mount, inside 3 to 4.2 s.
			for (const s of BOTS) {
				const f = await page
					.locator(`${s} .evry-bot`)
					.evaluate((el) => parseFloat(el.style.getPropertyValue("--eb-float")));
				assert.ok(f >= 3 && f <= 4.2, `float period ${f}`);
			}
			await page.waitForTimeout(1500);
			assert.deepEqual(
				logs.filter((l) => /hydrat|did not match|mismatch/i.test(l)),
				[],
			);
		}));

	test(
		`WP-097 Evry morph and acts (${name}): another shape each time, an act between every two morphs`,
		{ timeout: 180_000 },
		() =>
			withHome(
				engine,
				async (page) => {
					// The hero bot morphs: data-shape and the body path change.
					const first = await read(page, HERO);
					const step = await freeze(page);
					await step(9000);
					const later = await read(page, HERO);
					assert.notEqual(later.shape, first.shape, "the hero changes shape");
					assert.notEqual(later.body, first.body, "the hero body path changes");

					// 60 s of simulated time on the Monday overview bot (always idle).
					await page.locator(MONDAY).scrollIntoViewIfNeeded();
					await page.clock.resume();
					await page.waitForTimeout(300);
					const run = await freeze(page);
					await page.locator(`${MONDAY} .evry-bot`).evaluate((el) => {
						const log = (window.__evryLog = [["start", el.dataset.shape, performance.now()]]);
						new MutationObserver((list) => {
							for (const m of list) {
								const v = el.getAttribute(m.attributeName);
								if (m.attributeName === "data-shape") log.push(["morph", v, performance.now()]);
								else if (v) log.push(["act", v, performance.now()]);
							}
						}).observe(el, { attributes: true, attributeFilter: ["data-shape", "data-act"] });
					});
					for (let i = 0; i < 60; i++) await run(1000);
					const log = await page.evaluate(() => window.__evryLog);
					const morphs = log.filter((e) => e[0] === "morph");
					assert.ok(morphs.length >= 4, `morphs in 60 s: ${JSON.stringify(log)}`);
					const NAMES = ["triangle", "circle", "square", "pill", "hexagon"];
					let prev = log[0][1];
					for (const [, shape] of morphs) {
						assert.ok(NAMES.includes(shape));
						assert.notEqual(shape, prev, "each morph goes to another shape");
						prev = shape;
					}
					for (let i = 1; i < morphs.length; i++) {
						const acts = log.filter((e) => e[0] === "act" && e[2] > morphs[i - 1][2] && e[2] < morphs[i][2]);
						assert.ok(acts.length >= 1, `an act between morph ${i - 1} and ${i}: ${JSON.stringify(log)}`);
						assert.ok(acts.every((a) => ["look", "tilt", "sway"].includes(a[1])));
						// An idle hold is at least the 600 ms morph and its 2.6 s hold.
						assert.ok(morphs[i][2] - morphs[i - 1][2] >= 3200, `hold ${morphs[i][2] - morphs[i - 1][2]} ms`);
					}
				},
				{ clock: true },
			),
	);

	test(
		`WP-097 Evry look (${name}): the hero's eyes narrow toward the edge and stay inside the body`,
		{ timeout: 180_000 },
		() =>
			withHome(
				engine,
				async (page) => {
					await pauseHero(page);
					await page.waitForTimeout(300);
					const step = await freeze(page);
					let narrowest = Infinity;
					let rest = 0;
					let looks = 0;
					let leaned = null;
					for (let i = 0; i < 1500 && looks < 40; i++) {
						await step(32);
						const s = await read(page, HERO);
						if (s.act !== "look" || s.mood !== "idle") continue;
						const S = outline(s.body);
						const E = edges(S, newEdges());
						const fk = SHAPES[s.shape].fk;
						rest = 11 * fk;
						for (const d of s.eyes) {
							const m = margin(E, pairs(d).flat());
							assert.ok(m >= 3.5 - 0.1, `${s.shape}: eye margin ${m.toFixed(2)} (look frame ${i})`);
							narrowest = Math.min(narrowest, eyeWidth(d));
						}
						if (/rotate\(-?[\d.]+ 50 84\)/.test(s.g)) leaned = s;
						looks++;
					}
					assert.ok(looks >= 10, `look frames seen: ${looks}`);
					assert.ok(narrowest < 0.95 * rest, `an eye narrows: ${narrowest.toFixed(2)} at rest ${rest}`);
					// The body leans about the low pivot, and both gradients turn back with it (the fake 3D turn).
					assert.ok(leaned, "the body leans during the look");
					assert.match(leaned.sh, /^matrix\(/);
					assert.match(leaned.hl, /^matrix\(/);
				},
				{ clock: true },
			),
	);

	test(
		`WP-097 Evry rest eyes and blink (${name}): 0.11 x 0.23 of the size, ink, no white dot`,
		{ timeout: 120_000 },
		() =>
			withHome(
				engine,
				async (page) => {
					for (const s of BOTS) {
						await page.locator(s).scrollIntoViewIfNeeded();
						const m = await page.locator(s).evaluate((root) => {
							const bot = root.querySelector(".evry-bot").getBoundingClientRect();
							const eyes = [...root.querySelectorAll(".eb-e")].map((e) => {
								const r = e.getBoundingClientRect();
								return { w: r.width / bot.width, h: r.height / bot.height, fill: getComputedStyle(e).fill };
							});
							const shapes = root.querySelectorAll("circle, ellipse, rect").length;
							return { eyes, shapes, paths: root.querySelectorAll("path").length };
						});
						assert.equal(m.paths, 3, `${s}: body and two eyes only`);
						assert.equal(m.shapes, 0, `${s}: no highlight dot`);
						for (const e of m.eyes) {
							assert.ok(Math.abs(e.w / 0.11 - 1) < 0.05, `${s}: eye width ${e.w}`);
							assert.ok(Math.abs(e.h / 0.23 - 1) < 0.05, `${s}: eye length ${e.h}`);
							assert.equal(e.fill, INK);
						}
					}
					// Blinks: the loop sets data-blink, each eye shuts for 0.18 s around its own centre.
					const mon = page.locator(`${MONDAY} .evry-bot`);
					await page.locator(MONDAY).scrollIntoViewIfNeeded();
					await page.emulateMedia({ reducedMotion: "no-preference" });
					await until(() => mon.evaluate((el) => el.hasAttribute("data-blink")), 15_000, "a blink");
					const blink = await mon.evaluate((el) => {
						el.setAttribute("data-blink", "");
						const cs = getComputedStyle(el.querySelector(".eb-e"));
						return [cs.animationName, cs.animationDuration, cs.transformOrigin, cs.transformBox];
					});
					assert.equal(blink[0], "ef-eb-blink");
					assert.equal(blink[1], "0.18s");
					assert.equal(blink[3], "fill-box");
				},
				{ reduced: true },
			),
	);

	test(
		`WP-097 Evry moods (${name}): data-mood drives happy and thinking, talking renders idle`,
		{ timeout: 120_000 },
		() =>
			withHome(engine, async (page) => {
				await pauseHero(page);
				const hero = page.locator(HERO);
				const inner = page.locator(`${HERO} .evry-bot`);
				// The lg float runs while idle.
				assert.equal(
					await inner.evaluate((el) => getComputedStyle(el.querySelector(".eb-body")).animationName),
					"ef-eb-float",
				);
				assert.equal(
					await page.locator(`${MONDAY} .evry-bot .eb-body`).evaluate((el) => getComputedStyle(el).animationName),
					"none",
					"sm does not float",
				);

				// Happy: ^ ^ arches with round caps, the whole bot bounces, no float and no blink.
				await hero.evaluate((el) => {
					el.dataset.mood = "happy";
					const bot = el.querySelector(".evry-bot");
					bot.__blinks = 0;
					new MutationObserver(() => bot.hasAttribute("data-blink") && bot.__blinks++).observe(bot, {
						attributes: true,
						attributeFilter: ["data-blink"],
					});
				});
				await until(async () => /A/.test((await read(page, HERO)).eyes[0]), 3000, "arch eyes");
				const happy = await read(page, HERO);
				for (const d of happy.eyes) assert.match(d, /^M[\d. -]+A[\d. -]+0 1 [\d. -]+$/);
				const hs = await inner.evaluate((el) => {
					const e = getComputedStyle(el.querySelector(".eb-e"));
					return {
						bounce: getComputedStyle(el).animationName,
						dur: getComputedStyle(el).animationDuration,
						dir: getComputedStyle(el).animationDirection,
						float: getComputedStyle(el.querySelector(".eb-body")).animationName,
						stroke: e.strokeWidth,
						cap: e.strokeLinecap,
						fill: e.fill,
					};
				});
				assert.deepEqual(hs, {
					bounce: "ef-eb-bounce",
					dur: "0.9s",
					dir: "alternate",
					float: "none",
					stroke: "4.65px",
					cap: "round",
					fill: "none",
				});
				await page.waitForTimeout(8000);
				assert.equal(await inner.evaluate((el) => el.__blinks), 0, "happy never blinks");

				// Thinking: smaller rigid eyes up and to the right of their rest place; the dot orbits at lg, not at sm.
				await hero.evaluate((el) => (el.dataset.mood = "thinking"));
				const still = await until(
					async () => {
						const a = await read(page, HERO);
						await page.waitForTimeout(120);
						const b = await read(page, HERO);
						return !/A/.test(b.eyes[0]) && a.body === b.body && a.eyes.join() === b.eyes.join() && b;
					},
					10_000,
					"a thinking frame between morphs",
				);
				const S = SHAPES[still.shape];
				const restEyes = restPaths(still.shape, "thinking").eyes;
				for (let j = 0; j < 2; j++) {
					const [x, y] = centre(still.eyes[j]);
					const [rx, ry] = centre(restEyes[j]);
					assert.ok(x - rx > 1 && ry - y > 1.5, `look up and right: (${x - rx}, ${y - ry})`);
					const p = pairs(still.eyes[j]);
					const h = Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1]));
					const w = Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0]));
					assert.ok(Math.abs(h - 16 * S.fk) < 0.3, `thinking eye length ${h}`);
					assert.ok(Math.abs(w - 10.15 * S.fk) < 0.3, `thinking eye width ${w}`);
				}
				const dot = (s) => page.locator(`${s} .evry-bot`).evaluate((el) => getComputedStyle(el, "::after").content);
				assert.notEqual(await dot(HERO), "none", "the dot at lg");
				await page.locator(MONDAY).evaluate((el) => (el.dataset.mood = "thinking"));
				await until(
					async () => (await page.locator(`${MONDAY} .evry-bot`).getAttribute("data-mood")) === "thinking",
					3000,
					"sm thinking",
				);
				assert.equal(await dot(MONDAY), "none", "no dot at sm");

				// Talking and an unknown mood render as idle: capsule eyes, the inner bot is idle.
				for (const m of ["talking", "wobbly"]) {
					await hero.evaluate((el, v) => (el.dataset.mood = v), m);
					await until(async () => (await inner.getAttribute("data-mood")) === "idle", 3000, `${m} as idle`);
					assert.equal(await dot(HERO), "none");
					assert.equal(await inner.evaluate((el) => getComputedStyle(el).animationName), "none");
				}
			}),
	);

	test(`WP-097 Evry reduced motion (${name}): still circles, the preference applies live`, { timeout: 120_000 }, () =>
		withHome(
			engine,
			async (page) => {
				const circles = async () => {
					const rest = restPaths("circle", "idle");
					for (const s of BOTS) {
						const b = await read(page, s);
						assert.equal(b.shape, "circle");
						assert.equal(b.body, rest.body);
						assert.deepEqual(b.eyes, rest.eyes);
						assert.equal(b.g, "");
					}
				};
				const stillFor5s = async () => {
					const a = await snapshot(page);
					for (let i = 0; i < 10; i++) {
						await page.waitForTimeout(500);
						assert.deepEqual(await snapshot(page), a, `still at ${(i + 1) * 0.5} s`);
					}
					const anim = await page.evaluate(
						() =>
							[...document.querySelectorAll("[data-evry-bot], [data-evry-bot] *")].filter(
								(el) =>
									getComputedStyle(el).animationName !== "none" ||
									getComputedStyle(el, "::after").animationName !== "none",
							).length,
					);
					assert.equal(anim, 0, "no CSS animation runs");
					assert.equal(await page.locator("[data-evry-bot] [data-blink]").count(), 0);
				};
				await circles();
				await stillFor5s();
				// A happy or thinking bot is still too, with no dot.
				await page.locator(HERO).evaluate((el) => (el.dataset.mood = "thinking"));
				await page.waitForTimeout(300);
				assert.equal(
					await page.locator(`${HERO} .evry-bot`).evaluate((el) => getComputedStyle(el, "::after").display),
					"none",
				);
				await page.locator(HERO).evaluate((el) => (el.dataset.mood = "idle"));
				// The preference changes on the live page: the bots move, then stop again.
				await page.emulateMedia({ reducedMotion: "no-preference" });
				const first = await snapshot(page);
				await until(async () => (await snapshot(page)).join() !== first.join(), 15_000, "motion after the change");
				await page.emulateMedia({ reducedMotion: "reduce" });
				await page.waitForTimeout(200);
				await circles();
				await stillFor5s();
			},
			{ reduced: true },
		),
	);

	test(`WP-097 Evry offscreen (${name}): no bot on screen, no change and no frame`, { timeout: 120_000 }, () =>
		withHome(
			engine,
			async (page) => {
				const first = await snapshot(page);
				await until(async () => (await snapshot(page)).join() !== first.join(), 15_000, "motion in view");
				assert.ok((await page.evaluate(() => window.__evryFrames)) > 0, "the counter sees Evry frames in view");
				// Scroll to a place where every bot is more than 64 px outside the viewport.
				const y = await page.evaluate((sel) => {
					const spans = sel.map((s) => {
						const r = document.querySelector(s).getBoundingClientRect();
						return [r.top + scrollY - 64, r.bottom + scrollY + 64];
					});
					const h = innerHeight;
					for (let y = 0; y < document.documentElement.scrollHeight - h; y += 50)
						if (spans.every(([a, b]) => b < y || a > y + h)) return y;
					return -1;
				}, BOTS);
				assert.ok(y >= 0, "a scroll place with no bot near the viewport");
				await page.evaluate((v) => window.scrollTo(0, v), y);
				await page.waitForTimeout(600);
				const off = await snapshot(page);
				const runs = await page.evaluate(() => window.__evryFrames);
				await page.waitForTimeout(5000);
				assert.deepEqual(await snapshot(page), off, "paths stop changing off screen");
				assert.equal(
					await page.evaluate(() => window.__evryFrames),
					runs,
					"no Evry requestAnimationFrame call with every bot off screen",
				);
				// Back in view the hero moves again.
				await page.evaluate(() => window.scrollTo(0, 0));
				await until(async () => (await snapshot(page)).join() !== off.join(), 15_000, "motion back in view");
				// On a hidden page the bots stop too.
				await page.evaluate(() => {
					Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await page.waitForTimeout(400);
				const hidden = await snapshot(page);
				const hiddenRuns = await page.evaluate(() => window.__evryFrames);
				await page.waitForTimeout(3000);
				assert.deepEqual(await snapshot(page), hidden, "paths stop on a hidden page");
				assert.equal(await page.evaluate(() => window.__evryFrames), hiddenRuns, "no Evry frame on a hidden page");
			},
			{
				// Counts requestAnimationFrame calls for the Evry loop. Motion's own frame loop keeps running for other
				// scenes, so the counter keeps only callbacks that check the page visibility: the shared life loop's tick
				// is the only frame callback on / that does. The in-view check proves the counter sees its frames.
				init: () => {
					const raf = window.requestAnimationFrame.bind(window);
					window.__evryFrames = 0;
					window.requestAnimationFrame = (cb) => {
						if (/document\.hidden/.test(Function.prototype.toString.call(cb))) window.__evryFrames++;
						return raf(cb);
					};
				},
			},
		),
	);
}
