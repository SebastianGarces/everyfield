// The ported Evry (WP-088) on the foundations preview, in a real browser with motion allowed. The checks read the paths
// and the root attributes the life loop writes (data-shape, data-act, data-blink); nothing in the product exposes test
// hooks. Two test-only harnesses run in the page: a requestAnimationFrame counter and a React DevTools hook that counts
// EvryBot renders.
//   INV-morph-act: an idle bot morphs to another shape, and every hold between two morphs carries an idle act.
//   INV-foreshorten: with the gaze held toward an edge (pointer follow), each eye is narrower than at rest and keeps
//     the prototype's margin inside the body path; the body leans toward the gaze and turns (narrows, highlight slides).
//   INV-follow: the eyes return to centre about 1.6 s after the last pointer move; a bot without follow ignores it.
//   INV-moods: happy draws arches, never blinks and bounces; thinking looks up and right with smaller rigid eyes, morphs
//     faster and shows the dot from md up; a mood change reaches a mounted bot without a remount.
//   INV-reduced: under reduced motion nothing moves and each bot is the circle or its held shape; the preference
//     applies at runtime without a reload.
//   INV-offscreen: bots off screen or on a hidden page stop; with every bot off screen no frame runs for 2 s.
//   INV-no-render: the loop causes no React render after mount.
//   INV-ssr: the server renders the full SVG with the first shape and rest eyes; hydration logs no warning.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/foundations/evry-bot.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { edges, margin, newEdges, restPaths, SHAPES } from "../../../packages/ui/src/foundations/evry-geo.ts";
import { BASE, ENGINES } from "../setup.mjs";

const PAGE = "/design/foundations";
const FOLLOW = ".evry-bot[data-follow]";
const THINKING = '#evry .evry-bot[data-size="xl"][data-mood="thinking"]';
const HAPPY = '#evry .evry-bot[data-size="xl"][data-mood="happy"]';
const HELD = '#evry .evry-bot[data-size="xl"][data-hold]';

/** Opens the foundations preview in `engine` with motion allowed (unless `reduced`), then runs `run`. */
async function withEvry(engine, run, { reduced = false, width = 1440, init } = {}) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({
			viewport: { width, height: 900 },
			reducedMotion: reduced ? "reduce" : "no-preference",
			ignoreHTTPSErrors: true,
		});
		if (init) await context.addInitScript(init);
		const page = await context.newPage();
		const logs = [];
		page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
		page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
		await page.goto(BASE + PAGE, { waitUntil: "networkidle" });
		await page.locator(`${FOLLOW}[data-eb]`).waitFor({ state: "attached", timeout: 60_000 });
		await run(page, logs);
	} finally {
		await browser.close();
	}
}

/** Every number in an SVG path, as [x, y] pairs. */
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

/** The drawn state of the bot at `selector`: body path, eye paths, group and gradient transforms, root attributes. */
const read = (page, selector) =>
	page
		.locator(selector)
		.first()
		.evaluate((el) => ({
			body: el.querySelector("defs path").getAttribute("d"),
			eyes: [...el.querySelectorAll(".eb-e")].map((e) => e.getAttribute("d")),
			g: el.querySelector(".eb-g").getAttribute("transform") ?? "",
			hl: el.querySelector("radialGradient").getAttribute("gradientTransform") ?? "",
			sh: el.querySelector("linearGradient").getAttribute("gradientTransform") ?? "",
			shape: el.dataset.shape,
			mood: el.dataset.mood,
		}));
/** The drawn paths of every bot on the page. */
const snapshot = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll(".evry-bot")].map(
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

/** Keeps the pointer at (x, y) relative to the follow bot's centre, moving it a pixel every 400 ms so follow stays on. */
async function pointAt(page, dx, dy, ms) {
	const box = await page.locator(FOLLOW).boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const end = Date.now() + ms;
	for (let i = 0; Date.now() < end; i++) {
		await page.mouse.move(cx + dx + (i % 2), cy + dy);
		await page.waitForTimeout(400);
	}
}

for (const [name, engine] of ENGINES) {
	test(`INV-morph-act (${name}): an idle bot morphs twice with an idle act between`, { timeout: 120_000 }, () =>
		withEvry(engine, async (page) => {
			await page.locator(FOLLOW).scrollIntoViewIfNeeded();
			await page.locator(FOLLOW).evaluate((el) => {
				const log = (window.__evryLog = []);
				new MutationObserver((list) => {
					for (const m of list) {
						const v = el.getAttribute(m.attributeName);
						if (m.attributeName === "data-shape") log.push(["morph", v, performance.now()]);
						else if (v) log.push(["act", v, performance.now()]);
					}
				}).observe(el, { attributes: true, attributeFilter: ["data-shape", "data-act"] });
			});
			const log = await until(
				async () => {
					const l = await page.evaluate(() => window.__evryLog);
					return l.filter((e) => e[0] === "morph").length >= 2 && l;
				},
				60_000,
				"two morphs",
			);
			const morphs = log.filter((e) => e[0] === "morph");
			assert.notEqual(morphs[0][1], morphs[1][1], "the next shape differs");
			const between = log.filter((e) => e[0] === "act" && e[2] > morphs[0][2] && e[2] < morphs[1][2]);
			assert.ok(between.length >= 1, `an act between two morphs: ${JSON.stringify(log)}`);
			assert.ok(["look", "tilt", "sway"].includes(between[0][1]));
			// A hold lasts at least 2.6 s plus the morph (0.6 s) before the next morph starts.
			assert.ok(morphs[1][2] - morphs[0][2] >= 3100, `hold ${morphs[1][2] - morphs[0][2]} ms`);
		}),
	);

	test(
		`INV-foreshorten INV-follow (${name}): eyes narrow at the edge, stay inside and return to centre`,
		{ timeout: 120_000 },
		() =>
			withEvry(engine, async (page) => {
				await page.locator(FOLLOW).scrollIntoViewIfNeeded();
				// Looking up, both eyes near a slanted or curved edge on these shapes (a flat top only shortens them).
				const shape = await until(
					async () => {
						const s = await page.locator(FOLLOW).getAttribute("data-shape");
						return ["triangle", "circle", "hexagon"].includes(s) && s;
					},
					60_000,
					"a triangle, circle or hexagon",
				);
				await pointAt(page, 0, -400, 1600);
				const up = await read(page, FOLLOW);
				assert.equal(up.shape, shape, "a follow holds the shape");
				const S = SHAPES[shape];
				const rest = 11 * S.fk;
				const P = outline(up.body);
				const E = edges(P, newEdges());
				for (const d of up.eyes) {
					assert.ok(eyeWidth(d) < 0.95 * rest, `${shape}: width ${eyeWidth(d).toFixed(2)} at rest ${rest}`);
					// The prototype's margin, less the 0.1 rounding of the eye path.
					assert.ok(margin(E, pairs(d).flat()) >= 3.5 - 0.1, `${shape}: margin ${margin(E, pairs(d).flat())}`);
				}
				const [l, r] = up.eyes.map(centre);
				assert.ok(l[1] < 45 && r[1] < 45, `eyes look up: ${l[1]}, ${r[1]}`);

				// To the right: the lead eye narrows, the body leans right about the low pivot (at most 3 degrees), narrows
				// and the highlight slides left. The gradients turn back with the tilt.
				await pointAt(page, 400, 0, 1600);
				const right = await read(page, FOLLOW);
				assert.ok(eyeWidth(right.eyes[1]) < 0.95 * rest, `right eye ${eyeWidth(right.eyes[1])}`);
				const tilt = Number(/rotate\((-?[\d.]+) 50 84\)/.exec(right.g)?.[1]);
				assert.ok(tilt > 0 && tilt <= 3, `lean ${right.g}`);
				const sx = Number(/scale\(([\d.]+) /.exec(right.g)?.[1]);
				assert.ok(sx < 0.99 && sx >= 0.965, `turn ${right.g}`);
				assert.match(right.hl, /translate\(-0\.\d+ /);
				assert.match(right.sh, /^matrix\(/);

				// About 1.6 s after the last move the eyes are back at rest.
				const last = Date.now();
				const restEyes = restPaths(shape, "idle").eyes;
				await until(async () => (await read(page, FOLLOW)).eyes.join() === restEyes.join(), 4000, "eyes at rest");
				const back = Date.now() - last;
				assert.ok(back >= 1400 && back <= 3200, `back after ${back} ms`);

				// A held bot without follow ignores the pointer.
				const held = page.locator(HELD).first();
				const before = await read(page, HELD);
				const box = await held.boundingBox();
				for (const [x, y] of [
					[box.x - 200, box.y],
					[box.x + 300, box.y + 200],
					[box.x, box.y - 250],
				]) {
					await page.mouse.move(x, y);
					await page.waitForTimeout(300);
				}
				assert.deepEqual(await read(page, HELD), before);
			}),
	);

	test(`INV-moods (${name}): happy, thinking and a mood change on a mounted bot`, { timeout: 120_000 }, () =>
		withEvry(engine, async (page) => {
			await page.locator(THINKING).scrollIntoViewIfNeeded();
			for (const s of [THINKING, HAPPY, FOLLOW])
				await page.locator(s).evaluate((el) => {
					el.__log = [];
					new MutationObserver((l) =>
						l.forEach((m) => el.getAttribute(m.attributeName) !== null && el.__log.push(m.attributeName)),
					).observe(el, { attributes: true, attributeFilter: ["data-shape", "data-blink"] });
				});
			await page.waitForTimeout(10_000);
			const logOf = (s) => page.locator(s).evaluate((el) => el.__log);
			// Thinking morphs at its faster cadence: a morph every 1.45 to 2.5 s, the first within 2 s.
			const thinkingLog = await logOf(THINKING);
			assert.ok(thinkingLog.filter((a) => a === "data-shape").length >= 3, `thinking: ${thinkingLog}`);
			assert.equal((await logOf(HAPPY)).filter((a) => a === "data-blink").length, 0, "happy never blinks");
			assert.ok((await logOf(FOLLOW)).includes("data-blink"), "idle blinks");

			// Happy: round-capped arches and the bounce.
			const happy = await read(page, HAPPY);
			for (const d of happy.eyes) assert.match(d, /^M[\d. ]+A[\d. ]+0 1 [\d. ]+$/);
			assert.equal(await page.locator(HAPPY).evaluate((el) => getComputedStyle(el).animationName), "ef-eb-bounce");

			// Thinking: smaller rigid upright eyes above and right of their rest place, while the shape holds.
			const still = await until(
				async () => {
					const a = await read(page, THINKING);
					await page.waitForTimeout(120);
					const b = await read(page, THINKING);
					return a.body === b.body && a.eyes.join() === b.eyes.join() && b;
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
				const height = Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1]));
				assert.ok(Math.abs(height - 16 * S.fk) < 0.3, `thinking eye length ${height}`);
			}
			// The thinking dot shows from md up only.
			const dot = (s) =>
				page
					.locator(s)
					.first()
					.evaluate((el) => getComputedStyle(el, "::after").content);
			assert.notEqual(await dot(THINKING), "none");
			const sm = page.locator('.evry-bot[data-size="sm"]').first();
			assert.equal(
				await sm.evaluate((el) => {
					el.dataset.mood = "thinking";
					const c = getComputedStyle(el, "::after").content;
					el.dataset.mood = "idle";
					return c;
				}),
				"none",
			);

			// A click makes the idle bot happy for 1.4 s on the same element: no remount.
			const bot = page.locator(FOLLOW);
			await bot.evaluate((el) => (el.__same = true));
			await page.getByRole("button", { name: "Make Evry happy" }).click();
			await until(async () => (await bot.getAttribute("data-mood")) === "happy", 4000, "happy");
			await until(async () => /A/.test((await read(page, FOLLOW)).eyes[0]), 2000, "arch eyes");
			await until(async () => (await bot.getAttribute("data-mood")) === "idle", 4000, "idle again");
			await until(async () => !/A/.test((await read(page, FOLLOW)).eyes[0]), 2000, "capsule eyes");
			assert.equal(await bot.evaluate((el) => el.__same), true, "the same element");
		}),
	);

	test(`INV-reduced (${name}): nothing moves and each bot is the circle or its held shape`, { timeout: 120_000 }, () =>
		withEvry(
			engine,
			async (page) => {
				await page.locator(FOLLOW).scrollIntoViewIfNeeded();
				const shapes = () =>
					page.evaluate(() =>
						[...document.querySelectorAll(".evry-bot")].map((el) => [el.dataset.shape, el.hasAttribute("data-hold")]),
					);
				const stillShapes = async () => {
					for (const [shape, held] of await shapes()) if (!held) assert.equal(shape, "circle");
					const box = page.locator(HELD);
					assert.deepEqual(await box.evaluateAll((els) => els.map((el) => el.dataset.shape)), [
						"triangle",
						"circle",
						"square",
						"pill",
						"hexagon",
					]);
				};
				const sampleStill = async () => {
					const a = await snapshot(page);
					for (let i = 0; i < 6; i++) {
						await page.waitForTimeout(500);
						await page.mouse.move(100 + i * 150, 100 + i * 100);
						assert.deepEqual(await snapshot(page), a, `still at ${(i + 1) * 0.5} s`);
					}
					const anim = await page.evaluate(
						() =>
							[...document.querySelectorAll(".evry-bot, .evry-bot *")].filter(
								(el) => getComputedStyle(el).animationName !== "none",
							).length,
					);
					assert.equal(anim, 0, "no CSS animation runs");
					assert.equal(await page.locator("#evry .evry-bot[data-blink]").count(), 0);
				};
				await stillShapes();
				await sampleStill();
				// The preference changes at runtime: the bots start moving, then stop again on reduce.
				await page.emulateMedia({ reducedMotion: "no-preference" });
				const first = await snapshot(page);
				await until(async () => (await snapshot(page)).join() !== first.join(), 15_000, "motion after the change");
				await page.emulateMedia({ reducedMotion: "reduce" });
				await page.waitForTimeout(100);
				await stillShapes();
				await sampleStill();
			},
			{ reduced: true },
		),
	);

	test(`INV-offscreen (${name}): bots off screen or on a hidden page do no work`, { timeout: 120_000 }, () =>
		withEvry(
			engine,
			async (page) => {
				const evry = page.locator("#evry");
				await evry.scrollIntoViewIfNeeded();
				const first = await snapshot(page);
				await until(async () => (await snapshot(page)).join() !== first.join(), 10_000, "motion in view");
				// Hide the bots outside the Evry section (the top bar's Ask Evry never scrolls away) and scroll the section out of view.
				await page.evaluate(() => {
					for (const el of document.querySelectorAll(".evry-bot:not(#evry *)")) el.style.display = "none";
					window.scrollTo(0, 0);
				});
				assert.equal(await evry.evaluate((el) => el.getBoundingClientRect().top > innerHeight + 64), true);
				await page.waitForTimeout(400);
				const off = await snapshot(page);
				const runs = await page.evaluate(() => window.__rafRuns);
				await page.waitForTimeout(2000);
				assert.deepEqual(await snapshot(page), off, "paths stop changing off screen");
				assert.equal(await page.evaluate(() => window.__rafRuns), runs, "no frame runs with every bot off screen");

				// Back in view the bots move again; on a hidden page they stop.
				await evry.scrollIntoViewIfNeeded();
				await until(async () => (await snapshot(page)).join() !== off.join(), 15_000, "motion back in view");
				await page.evaluate(() => {
					Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await page.waitForTimeout(400);
				const hidden = await snapshot(page);
				const hiddenRuns = await page.evaluate(() => window.__rafRuns);
				await page.waitForTimeout(2000);
				assert.deepEqual(await snapshot(page), hidden, "paths stop on a hidden page");
				assert.equal(await page.evaluate(() => window.__rafRuns), hiddenRuns, "no frame runs on a hidden page");
			},
			{
				init: () => {
					const raf = window.requestAnimationFrame.bind(window);
					window.__rafRuns = 0;
					window.requestAnimationFrame = (cb) =>
						raf((t) => {
							window.__rafRuns++;
							cb(t);
						});
				},
			},
		),
	);

	test(`INV-no-render (${name}): 3 s of animation cause no EvryBot render`, { timeout: 120_000 }, () =>
		withEvry(
			engine,
			async (page) => {
				await page.locator("#evry").scrollIntoViewIfNeeded();
				await page.waitForTimeout(500);
				const start = await page.evaluate(() => ({ renders: window.__evryRenders.n, seen: window.__evryRenders.seen }));
				assert.ok(start.seen >= 18, `the hook sees the bots: ${start.seen}`);
				const first = await snapshot(page);
				await page.waitForTimeout(3000);
				assert.notDeepEqual(await snapshot(page), first, "the bots animated");
				assert.equal(await page.evaluate(() => window.__evryRenders.n), start.renders, "no EvryBot render");
			},
			{
				// A minimal React DevTools hook: React reports each commit. An EvryBot fiber (its host child is the
				// .evry-bot span) rendered again when its props object changed since the last commit.
				init: () => {
					const props = new WeakMap();
					const counter = (window.__evryRenders = { n: 0, seen: 0 });
					let id = 0;
					window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
						supportsFiber: true,
						isDisabled: false,
						renderers: new Map(),
						checkDCE() {},
						inject(renderer) {
							this.renderers.set(++id, renderer);
							return id;
						},
						onScheduleFiberRoot() {},
						onCommitFiberUnmount() {},
						onPostCommitFiberRoot() {},
						onCommitFiberRoot(_, root) {
							let seen = 0;
							const stack = [root.current];
							while (stack.length) {
								const f = stack.pop();
								if (typeof f.type === "function" && f.child?.stateNode?.classList?.contains("evry-bot")) {
									seen++;
									const el = f.child.stateNode;
									if (props.has(el) && props.get(el) !== f.memoizedProps) counter.n++;
									props.set(el, f.memoizedProps);
								}
								if (f.sibling) stack.push(f.sibling);
								if (f.child) stack.push(f.child);
							}
							counter.seen = Math.max(counter.seen, seen);
						},
					};
				},
			},
		),
	);

	test(
		`INV-ssr (${name}): the server renders the first state and hydration logs no warning`,
		{ timeout: 120_000 },
		() =>
			withEvry(engine, async (page, logs) => {
				const html = await (await page.request.get(BASE + PAGE)).text();
				const bots = html.match(/<span[^>]*class="evry-bot"[^>]*>.*?<\/svg><\/span><\/span>/g) ?? [];
				assert.ok(bots.length >= 18, `server bots: ${bots.length}`);
				for (const bot of bots) {
					const shape = /data-shape="(\w+)"/.exec(bot)[1];
					const mood = /data-mood="(\w+)"/.exec(bot)[1];
					const rest = restPaths(shape, mood);
					assert.match(bot, /<svg viewBox="0 0 100 100"/);
					assert.ok(bot.includes(`d="${rest.body}"`), `${shape} body`);
					for (const eye of rest.eyes) assert.ok(bot.includes(`d="${eye}"`), `${shape} ${mood} eyes`);
					assert.match(bot, /<linearGradient[^>]*id="eb[\w-]+s"/);
					assert.match(bot, /<radialGradient[^>]*id="eb[\w-]+h"/);
					assert.equal(bot.match(/class="eb-e"/g).length, 2);
					if (!bot.includes("data-hold")) assert.equal(shape, "circle");
				}
				await page.waitForTimeout(1500);
				assert.deepEqual(
					logs.filter((l) => /hydrat|did not match|mismatch/i.test(l)),
					[],
				);
			}),
	);
}
