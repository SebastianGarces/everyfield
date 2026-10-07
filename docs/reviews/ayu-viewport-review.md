# Ayu theme and fixed viewport review

The [local explorer](../../everyfield-build-explorer.html) now fits the browser viewport without document/body scrolling in either axis. Tree exploration scrolls and pans inside the canvas. Long selected-item content scrolls within its own inspector; narrow windows use a contained drawer with a reachable Close control. Open menus and edit dialogs also contain their long content.

The minimal header toggle selects Ayu Dark or Light. Dark is the initial source default; a valid saved user choice takes precedence on reopen. Preference uses the separate `everyfield-build-explorer:theme:v1` key and never changes the progress override schema. The toggle is a native button with a stable accessible name, pressed state and visible keyboard focus. Portable HTML carries the selected theme, including when preference storage is unavailable; the [maintained renderer](../render-build-explorer.py) preserves that explicit choice during UI-only refreshes.

Colors follow the official [Ayu dark palette](https://github.com/ayu-theme/ayu-colors/blob/master/themes/dark.yaml) and [light palette](https://github.com/ayu-theme/ayu-colors/blob/master/themes/light.yaml), checked 2026-10-05. Surface, accent and status colors come from Ayu; foreground, border, focus and warning/error text roles are adjusted for rendered contrast. Nodes, edges, statuses, inspector, menus, dialogs, inputs, placeholder text and focus styles all use theme tokens. SVG containment strokes remain visible through zoom.

Verification passed **274 browser checks**: 177 theme/viewport checks, the existing 77 explorer regression checks, and 20 exact-primary checks. The viewport suite exercised both themes at 1440×1000, 1280×720, 1024×768, 780×500, 760×500, 640×360, 390×844, 375×667, 320×568, 320×400 and 1080×320. Document/body bounds stayed within each viewport; attempts to scroll the page did not move it. Canvas movement in both axes, real wheel and pointer dragging, long inspector content, narrow drawer focus and short-window edit-dialog scrolling were checked.

The rendered color checks passed normal-text contrast of at least 4.5:1, tree-edge and actual keyboard-focus contrast of at least 3:1, and the recorded APCA body/label thresholds. These are scoped UI measurements, not a full accessibility-conformance claim. Theme switching with Space, reload, reopen, invalid preference fallback, unavailable-storage behavior and standalone portable export were verified. Browser checks recorded zero runtime errors or outbound runtime requests. All 670 package/feature/table panels and 882 attributes still render; progress merge/replace, cancellation, evidence retention, stale revisions, reset and prerequisite gates still pass.

**27 disposable maintenance fixtures** passed: 12 Ayu/portable-theme checks and the 15 existing template/updater fixtures. Rendering and progress refresh preserve the current shell, source data, canonical progress and explicit portable theme. Shared locking and invalid-template/symlink rejection remain intact. [Template](../explorer-ui.template.html), [renderer](../render-build-explorer.py), [workflow](../build-agent-workflow.md) and workspace compatibility generators all follow the maintained source.

All three embedded JSON payloads, the source fingerprint and progress import/export format are unchanged. Canonical progress remains revision 0, **0 of 86 completed**. The 3,960 main/alpha source hashes and all earlier review documents are preserved. No application implementation, architecture/methodology decision, database change, deployment or upload occurred.

Fresh-context screenshots were opened for visual inspection in both themes:

- [Dark overview](explorer-screenshots/ayu-dark-overview.png) · [Light overview](explorer-screenshots/ayu-light-overview.png)
- [Dark schema](explorer-screenshots/ayu-dark-schema.png) · [Light schema](explorer-screenshots/ayu-light-schema.png)
- [Dark narrow drawer](explorer-screenshots/ayu-dark-narrow.png) · [Light narrow drawer](explorer-screenshots/ayu-light-narrow.png)

[Machine evidence](../evidence/ayu-viewport-review.json) records each check, rendered color pairs, exact source/file hashes, viewport bounds and screenshot hashes. No remaining blockers.
