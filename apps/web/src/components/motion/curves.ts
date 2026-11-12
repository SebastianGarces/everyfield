// The prototype's timing curves (design/everyfield-marketing.html). Every scene is a pure function of its clock t (ms)
// built from these, so a frame can be computed for any t: reduced motion renders the scene's still time once.

export const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Progress of a step that starts at a and lasts d, clamped to 0..1. */
export const P = (t: number, a: number, d: number) => clamp((t - a) / d);
export const out = (p: number) => 1 - Math.pow(1 - p, 3);
export const inOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
export const sine = (p: number) => -(Math.cos(Math.PI * p) - 1) / 2;
export const back = (p: number) => {
	const c = 1.6;
	return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};
/** 0 → 1 → 0 over the step (a button press). */
export const bump = (t: number, a: number, d: number) => Math.sin(Math.PI * P(t, a, d));

/** One frame of an element: translate x, y (px), scale and opacity. */
export type Frame = readonly [x: number, y: number, s: number, o: number];
export const transformOf = (x: number, y: number, s: number) =>
	"translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" + (s === 1 ? "" : " scale(" + s.toFixed(4) + ")");

/* The shared moves of the panels. R is the loop's reset factor: 1 while the scene plays, falling to 0 at its loop end. */
/** Rise 8 px and fade in over 420 ms. */
export const rise = (t: number, at: number, R = 1): Frame => {
	const p = out(P(t, at, 420));
	return [0, (1 - p) * 8, 1, p * R];
};
