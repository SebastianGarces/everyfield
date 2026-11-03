/**
 * Preloaded (NODE_OPTIONS --import, set by fixtures.ts) into every Node process a test starts. An evf process on a
 * fixture repo then runs the fixture's base code, as fixtures.ts claims for the test process itself (OPS-111: ship
 * and drive refuse at their start on stale code). Other Node children, such as the fake gh and Herdr, load nothing.
 */
if (/[\\/]tools[\\/]evf[\\/][\w-]+\.ts$/.test(process.argv[1] ?? "")) {
	const { setLoadedCode } = await import("../merge.ts");
	setLoadedCode((base) => ({ checkout: "fixture", ...base, dirty: false }));
}
