import { fileProblems, importProblem, routeFeatures } from "./boundaries.mjs";
import { area, commentsExempt, ratchet, repoPath } from "./ratchet.mjs";

const RESEND_PACKAGE = /^resend(?:\/|$)/;
const RESEND_HOST = "api.resend.com";
const PRIVATE_CARE = /private_(?:week|calendar)|privateCare|createPrivateCare/;

const text = (node) =>
	node.type === "Literal" && typeof node.value === "string"
		? node.value
		: node.type === "TemplateElement"
			? (node.value.cooked ?? node.value.raw)
			: null;
const literalArgument = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : null);
const isRequire = (node) => node.callee.type === "Identifier" && node.callee.name === "require";

function moduleSources(report) {
	const fromSource = (node) => node.source && report(node, node.source.value);
	return {
		ImportDeclaration: fromSource,
		ExportNamedDeclaration: fromSource,
		ExportAllDeclaration: fromSource,
		ImportExpression: (node) => {
			const name = literalArgument(node.source);
			if (name !== null) report(node, name);
		},
		CallExpression: (node) => {
			const name = isRequire(node) ? literalArgument(node.arguments[0]) : null;
			if (name !== null) report(node, name);
		},
	};
}

const resendSenders = {
	meta: { type: "problem" },
	create(context) {
		const message =
			"Only the guarded senders (mail.ts, server/jobs/resend.ts, early-access) may reach Resend: send mail through them, so mailRecipientAllowed runs first.";
		const host = (node) => {
			if (text(node)?.includes(RESEND_HOST)) context.report({ node, message });
		};
		return {
			...moduleSources((node, name) => {
				if (RESEND_PACKAGE.test(name)) context.report({ node, message });
			}),
			Literal: host,
			TemplateElement: host,
		};
	},
};

const privateCareScope = {
	meta: { type: "problem" },
	create(context) {
		const message =
			"Only the intelligence domain names the private-care tables and operations; no Evry, job, export or log path may read them.";
		const check = (value, node) => {
			if (value && PRIVATE_CARE.test(value)) context.report({ node, message });
		};
		return {
			Identifier: (node) => check(node.name, node),
			JSXIdentifier: (node) => check(node.name, node),
			Literal: (node) => check(text(node), node),
			TemplateElement: (node) => check(text(node), node),
		};
	},
};

const noInnerHtml = {
	meta: { type: "problem" },
	create(context) {
		const message = "Render text, never raw HTML: dangerouslySetInnerHTML opens the page to injected markup.";
		const check = (value, node) => {
			if (value === "dangerouslySetInnerHTML") context.report({ node, message });
		};
		return {
			Identifier: (node) => check(node.name, node),
			JSXIdentifier: (node) => check(node.name, node),
			Literal: (node) => check(node.value, node),
		};
	},
};

const IMPURE_GLOBALS = new Set(["process", "fetch", "Date", "require"]);
const typeOnly = (node) =>
	node.importKind === "type" || (node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === "type"));
const isReference = (node) => {
	const parent = node.parent;
	if (!parent) return true;
	if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
	if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key === node && !parent.computed)
		return false;
	return !parent.type.startsWith("TS");
};

const pureModule = {
	meta: { type: "problem" },
	create(context) {
		const report = (node, what) =>
			context.report({
				node,
				message: `This module is a pure rule that reads only its arguments and does no I/O. Remove the ${what}.`,
			});
		return {
			ImportDeclaration: (node) => typeOnly(node) || report(node, "value import (a type import is fine)"),
			ImportExpression: (node) => report(node, "dynamic import"),
			AwaitExpression: (node) => report(node, "await"),
			ForOfStatement: (node) => node.await && report(node, "for await"),
			Identifier: (node) => IMPURE_GLOBALS.has(node.name) && isReference(node) && report(node, `use of ${node.name}`),
		};
	},
};

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const STATE_HOOKS = new Set(["useState", "useReducer"]);
const MAX_STATE = 4;
const TIMERS = new Set([
	"setTimeout",
	"setInterval",
	"setImmediate",
	"requestAnimationFrame",
	"requestIdleCallback",
	"queueMicrotask",
]);
const TIMER_HOSTS = new Set(["window", "globalThis", "self"]);
const REACT = new Set(["react"]);
const REACT_DOM = new Set(["react-dom"]);
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

export const INTERACTIVE_HOSTS = ["a", "button", "input", "label", "option", "select", "summary"];
export const INTERACTIVE_ROLES = [
	"button",
	"checkbox",
	"link",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"switch",
	"tab",
	"treeitem",
];
const POINTER_HANDLERS = new Set([
	"onClick",
	"onDoubleClick",
	"onMouseDown",
	"onMouseUp",
	"onPointerDown",
	"onPointerUp",
]);
const CURSOR_UTILITY = /^!?(?:[^\s:]+:)*!?cursor-(?:pointer|default|auto)!?$/;

const nameOf = (node) => (node.type === "Identifier" ? node.name : node.value);

function functionName(fn) {
	if (fn.id?.name) return fn.id.name;
	let node = fn;
	let parent = fn.parent;
	while (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
		node = parent;
		parent = parent.parent;
	}
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
	if (
		(parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") &&
		parent.key.type === "Identifier"
	)
		return parent.key.name;
	if (parent?.type === "AssignmentExpression" && parent.left.type === "Identifier") return parent.left.name;
	return parent?.type === "ExportDefaultDeclaration" ? "default" : null;
}

function enclosingName(node) {
	for (let p = node.parent; p; p = p.parent) {
		if (!FUNCTIONS.has(p.type)) continue;
		const name = functionName(p);
		if (name) return name;
	}
	return null;
}

function nearestFunction(node) {
	for (let p = node.parent; p; p = p.parent) if (FUNCTIONS.has(p.type)) return p;
	return null;
}

function bindings(program, sources, names, namespaces) {
	const direct = new Map();
	const spaces = new Set(namespaces);
	for (const s of program.body) {
		if (s.type !== "ImportDeclaration" || !sources.has(s.source.value) || s.importKind === "type") continue;
		for (const spec of s.specifiers) {
			if (spec.type === "ImportSpecifier") {
				if (spec.importKind !== "type" && names.has(nameOf(spec.imported)))
					direct.set(spec.local.name, nameOf(spec.imported));
			} else spaces.add(spec.local.name);
		}
	}
	return { direct, spaces };
}

const isMember = (node, objects, names) =>
	node.type === "MemberExpression" &&
	!node.computed &&
	node.object.type === "Identifier" &&
	objects.has(node.object.name) &&
	names.has(node.property.name);

function calledName(callee, b, names) {
	if (callee.type === "Identifier") return b.direct.get(callee.name) ?? null;
	return isMember(callee, b.spaces, names) ? callee.property.name : null;
}

const isRequireOf = (node, sources) =>
	node?.type === "CallExpression" && isRequire(node) && sources.has(literalArgument(node.arguments[0]) ?? "");

function moduleUses(sources, names, namespaces, found) {
	let b;
	return {
		Program(program) {
			b = bindings(program, sources, names, namespaces);
		},
		ExportNamedDeclaration(node) {
			if (node.source && sources.has(node.source.value))
				for (const s of node.specifiers) if (names.has(nameOf(s.local))) found(s, nameOf(s.local));
		},
		ExportAllDeclaration(node) {
			if (sources.has(node.source.value)) found(node, [...names].join(" or "));
		},
		VariableDeclarator(node) {
			if (node.id.type !== "ObjectPattern") return;
			const fromSpace = node.init?.type === "Identifier" && b.spaces.has(node.init.name);
			if (!fromSpace && !isRequireOf(node.init, sources)) return;
			for (const p of node.id.properties)
				if (p.type === "Property" && p.key.type === "Identifier" && names.has(p.key.name)) found(p, p.key.name);
		},
		MemberExpression(node) {
			if (!node.computed && isRequireOf(node.object, sources) && names.has(node.property.name))
				found(node, node.property.name);
		},
		CallExpression(node) {
			const name = calledName(node.callee, b, names);
			if (name) found(node, name);
		},
		Identifier(node) {
			const name = b.direct.get(node.name);
			const p = node.parent;
			if (!name || (p.type === "CallExpression" && p.callee === node)) return;
			if (p.type === "ImportSpecifier" || p.type === "ExportSpecifier") return;
			if (p.type === "MemberExpression" && p.property === node && !p.computed) return;
			found(node, name);
		},
	};
}

export const RATCHETED = [];

function ratcheted(rule, collect) {
	RATCHETED.push(rule);
	return {
		meta: { type: "problem" },
		create(context) {
			const violations = [];
			const visitors = collect(context, (v) => violations.push(v));
			const exit = visitors["Program:exit"];
			return {
				...visitors,
				"Program:exit"(node) {
					exit?.(node);
					ratchet(context, rule, violations);
				},
			};
		},
	};
}

const survivorFile = (context) => `scripts/lint/survivors/${area(repoPath(context.filename))}.json`;

const noEffects = ratcheted("no-effects", (context, push) =>
	moduleUses(REACT, EFFECT_HOOKS, ["React"], (node, name) =>
		push({
			node,
			fn: enclosingName(node),
			message: `${name} is banned. Derive the value while rendering, do the work in the event handler that causes it, reset state with a key, or subscribe with useSyncExternalStore. An effect that no other pattern can replace needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`,
		}),
	),
);

const isOwner = (name) => name === "default" || /^([A-Z]|use[A-Z0-9])/.test(name);

const maxState = ratcheted("max-state", (context, push) => {
	const owners = new Map();
	let b;
	return {
		Program(program) {
			b = bindings(program, REACT, STATE_HOOKS, ["React"]);
		},
		CallExpression(node) {
			if (!calledName(node.callee, b, STATE_HOOKS)) return;
			const fn = nearestFunction(node);
			const name = fn && functionName(fn);
			if (!name || !isOwner(name)) return;
			const owner = owners.get(fn) ?? { name, calls: [] };
			owner.calls.push(node);
			owners.set(fn, owner);
		},
		"Program:exit"() {
			for (const { name, calls } of owners.values())
				for (const node of calls.slice(MAX_STATE))
					push({
						node,
						fn: name,
						message: `${name} holds ${calls.length} useState and useReducer calls; at most ${MAX_STATE} are allowed. First delete state that should not exist (derived values, copied props, URL state, submit status, server data), then keep what is left in a zustand store and read it with selectors.`,
					});
		},
	};
});

const noTimers = ratcheted("no-timers", (context, push) => {
	const report = (node, name) =>
		push({
			node,
			fn: enclosingName(node),
			message: `${name} waits for time to pass instead of reacting to what the code waits for. Fix the ordering at its cause: act in the event handler, on the state change, on the promise or on the DOM node that is ready. A timer that is itself the product behavior (a countdown, a toast's lifetime, a poll, a typing debounce) needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`,
		});
	const flush = moduleUses(REACT_DOM, new Set(["flushSync"]), [], report);
	const timerModules = moduleUses(TIMER_MODULES, TIMERS, [], report);
	let timerSpaces = new Set();
	let imported = new Set();
	return {
		...flush,
		Program(program) {
			flush.Program(program);
			timerModules.Program(program);
			imported = new Set();
			timerSpaces = new Set();
			for (const s of program.body) {
				if (s.type !== "ImportDeclaration" || !TIMER_MODULES.has(s.source.value)) continue;
				for (const spec of s.specifiers)
					if (spec.type === "ImportSpecifier") imported.add(spec.local.name);
					else timerSpaces.add(spec.local.name);
			}
		},
		ExportNamedDeclaration(node) {
			flush.ExportNamedDeclaration(node);
			timerModules.ExportNamedDeclaration(node);
		},
		ExportAllDeclaration(node) {
			flush.ExportAllDeclaration(node);
			timerModules.ExportAllDeclaration(node);
		},
		VariableDeclarator(node) {
			flush.VariableDeclarator(node);
			timerModules.VariableDeclarator(node);
		},
		MemberExpression(node) {
			flush.MemberExpression(node);
			timerModules.MemberExpression(node);
		},
		Identifier(node) {
			flush.Identifier(node);
			timerModules.Identifier(node);
		},
		CallExpression(node) {
			flush.CallExpression(node);
			timerModules.CallExpression(node);
			const c = node.callee;
			if (c.type === "Identifier" && TIMERS.has(c.name) && !imported.has(c.name)) return report(node, c.name);
			if (isMember(c, TIMER_HOSTS, TIMERS)) return report(node, c.property.name);
			if (c.type !== "MemberExpression" || c.computed || c.property.name !== "wait") return;
			const host = c.object;
			const scheduler =
				(host.type === "Identifier" && (host.name === "scheduler" || imported.has(host.name))) ||
				(host.type === "MemberExpression" &&
					!host.computed &&
					host.property.name === "scheduler" &&
					host.object.type === "Identifier" &&
					(TIMER_HOSTS.has(host.object.name) || timerSpaces.has(host.object.name)));
			if (scheduler) report(node, "scheduler.wait");
		},
	};
});

const BUNDLER_IGNORE = /^\s*(?:webpackIgnore|turbopackIgnore):\s*true\s*$/;
const DIRECTIVE =
	/^\s*(?:@ts-|\/\s*<|(?:eslint|oxlint)-(?:disable|enable)|eslint-env\b|globals?\s|(?:biome|prettier)-ignore|[#@]__|(?:c8|istanbul|v8|node:coverage)\s+ignore|@jsx)/;

const noComments = ratcheted("no-comments", (context, push) => {
	if (commentsExempt(repoPath(context.filename))) return {};
	const imports = [];
	const span = (node) => node.range ?? [node.start, node.end];
	return {
		ImportExpression(node) {
			imports.push(span(node));
		},
		"Program:exit"() {
			for (const comment of context.sourceCode.getAllComments()) {
				if (comment.type === "Shebang") continue;
				const [start, end] = comment.range;
				const inImport = imports.some(([from, to]) => from < start && end < to);
				if (inImport && BUNDLER_IGNORE.test(comment.value)) continue;
				push({
					loc: comment.loc,
					fn: null,
					message: DIRECTIVE.test(comment.value)
						? "A lint, TypeScript or tool directive is banned. Fix the code it silences, or move the exception into lint config with its reason in scripts/lint/exemptions.json."
						: "Delete the comment. Name the code so it reads on its own, state a rule as a lint rule, type or test, and keep history in the PR or the evf task.",
				});
			}
		},
	};
});

const literalRole = (element) => {
	const role = element.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === "role");
	if (!role) return undefined;
	const value = role.value?.type === "JSXExpressionContainer" ? role.value.expression : role.value;
	return value?.type === "Literal" && typeof value.value === "string" ? value.value : null;
};

const clickableHost = ratcheted("clickable-host", (context, push) => ({
	JSXOpeningElement(node) {
		if (node.name.type !== "JSXIdentifier" || !/^[a-z]/.test(node.name.name)) return;
		if (INTERACTIVE_HOSTS.includes(node.name.name)) return;
		const handler = node.attributes.find((a) => a.type === "JSXAttribute" && POINTER_HANDLERS.has(a.name.name));
		if (!handler || INTERACTIVE_ROLES.includes(literalRole(node))) return;
		push({
			node: handler,
			fn: enclosingName(node),
			message: `${handler.name.name} on a <${node.name.name}> makes an element clickable that is not a control, so it gets no pointer cursor, focus or keyboard activation. Use a button, a link or a packages/ui primitive.`,
		});
	},
}));

const noCursorUtility = ratcheted("no-cursor-utility", (context, push) => {
	const check = (value, node) => {
		if (typeof value !== "string") return;
		for (const token of value.split(/\s+/))
			if (CURSOR_UTILITY.test(token))
				push({
					node,
					fn: enclosingName(node),
					message: `${token} at a call site: the base cursor rule in packages/ui/src/controls/controls.css owns the cursor of every clickable element. Delete the class, and make the element a button, a link or a packages/ui primitive if it does not get the pointer.`,
				});
	};
	return {
		Literal: (node) => check(node.value, node),
		TemplateElement: (node) => check(node.value.cooked ?? node.value.raw, node),
	};
});

const featureBoundaries = ratcheted("feature-boundaries", (context, push) => {
	const from = repoPath(context.filename);
	const imports = [];
	const found = (node, [, message]) => push({ node, fn: null, message });
	return {
		...moduleSources((node, spec) => {
			imports.push([node, spec]);
			const problem = importProblem(from, spec);
			if (problem) found(node, problem);
		}),
		Program(program) {
			for (const [node, ...problem] of fileProblems(from, program)) found(node, problem);
		},
		"Program:exit"() {
			const [node, ...problem] = routeFeatures(from, imports) ?? [];
			if (node) found(node, problem);
		},
	};
});

export default {
	meta: { name: "everyfield" },
	rules: {
		"resend-senders": resendSenders,
		"private-care-scope": privateCareScope,
		"pure-module": pureModule,
		"no-inner-html": noInnerHtml,
		"no-effects": noEffects,
		"max-state": maxState,
		"no-timers": noTimers,
		"no-comments": noComments,
		"clickable-host": clickableHost,
		"no-cursor-utility": noCursorUtility,
		"feature-boundaries": featureBoundaries,
	},
};
