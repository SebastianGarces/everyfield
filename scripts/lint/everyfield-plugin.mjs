import { area, commentsExempt, ratchet, repoPath, sqlMarkers } from "./ratchet.mjs";

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

export const INTERACTIVE_HOSTS = ["a[href]", "area[href]", "button", "input", "option", "select", "summary"];
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

const keyName = (key, computed) =>
	!computed && key.type === "Identifier"
		? key.name
		: key.type === "Literal" && typeof key.value === "string"
			? key.value
			: null;
const memberName = (node) => (node?.type === "MemberExpression" ? keyName(node.property, node.computed) : null);
const isMember = (node, objects, names) =>
	node?.type === "MemberExpression" &&
	node.object.type === "Identifier" &&
	objects.has(node.object.name) &&
	names.has(memberName(node));

function calledName(callee, b, names) {
	if (callee.type === "Identifier") return b.direct.get(callee.name) ?? null;
	return isMember(callee, b.spaces, names) ? memberName(callee) : null;
}

const isRequireOf = (node, sources) =>
	node?.type === "CallExpression" && isRequire(node) && sources.has(literalArgument(node.arguments[0]) ?? "");
const isImportOf = (node, sources) =>
	node?.type === "ImportExpression" && sources.has(literalArgument(node.source) ?? "");
const unwrap = (node) => (node?.type === "AwaitExpression" ? node.argument : node);
const isModuleValue = (node, b, sources) => {
	const value = unwrap(node);
	return (
		(value?.type === "Identifier" && b.spaces.has(value.name)) ||
		isRequireOf(value, sources) ||
		isImportOf(value, sources)
	);
};

const VALUE_TS = new Set([
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"TSTypeAssertion",
	"TSInstantiationExpression",
]);

function isValueReference(node) {
	const p = node.parent;
	if (!p) return true;
	if (/^(Import|Export)(Default|Namespace)?Specifier$/.test(p.type)) return false;
	if (p.type === "MemberExpression" && p.property === node && !p.computed) return false;
	if (
		(p.type === "Property" || p.type === "PropertyDefinition" || p.type === "MethodDefinition") &&
		p.key === node &&
		!p.computed &&
		!(p.shorthand && p.value === node)
	)
		return false;
	if (
		(p.type === "VariableDeclarator" && p.id === node) ||
		(FUNCTIONS.has(p.type) && (p.id === node || p.params.includes(node)))
	)
		return false;
	for (let up = p; up?.type.startsWith("TS"); up = up.parent) if (!VALUE_TS.has(up.type)) return false;
	return true;
}

function declared(context, node) {
	for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
		const variable = scope.set?.get(node.name);
		if (variable?.defs?.length) return true;
	}
	return false;
}

function moduleUses(sources, names, namespaces, found, dynamic = false) {
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
		ImportExpression(node) {
			if (dynamic && isImportOf(node, sources)) found(node, `import("${literalArgument(node.source)}")`);
		},
		VariableDeclarator(node) {
			if (node.id.type !== "ObjectPattern" || !isModuleValue(node.init, b, sources)) return;
			for (const p of node.id.properties) {
				const name = p.type === "Property" ? keyName(p.key, p.computed) : null;
				if (names.has(name)) found(p, name);
			}
		},
		MemberExpression(node) {
			const name = memberName(node);
			if (names.has(name) && isModuleValue(node.object, b, sources)) found(node, name);
		},
		Identifier(node) {
			const name = b.direct.get(node.name);
			if (name && isValueReference(node)) found(node, name);
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
	moduleUses(
		REACT,
		EFFECT_HOOKS,
		["React"],
		(node, name) =>
			push({
				node,
				fn: enclosingName(node),
				message: name.startsWith("import(")
					? `${name} hides which hooks the code uses. Import from react statically.`
					: `${name} is banned. Derive the value while rendering, do the work in the event handler that causes it, reset state with a key, or subscribe with useSyncExternalStore. An effect that no other pattern can replace needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`,
			}),
		true,
	),
);

const isOwner = (name) => name === "default" || /^([A-Z]|use[A-Z0-9])/.test(name);

const maxState = ratcheted("max-state", (context, push) => {
	const owners = new Map();
	let b;
	const stateName = (node) =>
		node?.type === "Identifier"
			? (b.direct.get(node.name) ?? null)
			: isMember(node, b.spaces, STATE_HOOKS)
				? memberName(node)
				: null;
	return {
		Program(program) {
			b = bindings(program, REACT, STATE_HOOKS, ["React"]);
		},
		VariableDeclarator(node) {
			if (node.id.type === "Identifier") {
				const name = stateName(node.init);
				if (name) b.direct.set(node.id.name, name);
			} else if (node.id.type === "ObjectPattern" && isModuleValue(node.init, b, REACT))
				for (const p of node.id.properties) {
					const name = p.type === "Property" ? keyName(p.key, p.computed) : null;
					if (STATE_HOOKS.has(name) && p.value.type === "Identifier") b.direct.set(p.value.name, name);
				}
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

const merge = (...parts) => {
	const merged = {};
	for (const part of parts)
		for (const [key, visit] of Object.entries(part)) {
			const before = merged[key];
			merged[key] = before ? (node) => (before(node), visit(node)) : visit;
		}
	return merged;
};

const noTimers = ratcheted("no-timers", (context, push) => {
	const seen = new Set();
	const report = (node, name) => {
		const at = (node.range ?? [node.start, node.end]).join(":");
		if (seen.has(at)) return;
		seen.add(at);
		push({
			node,
			fn: enclosingName(node),
			message: `${name} waits for time to pass instead of reacting to what the code waits for. Fix the ordering at its cause: act in the event handler, on the state change, on the promise or on the DOM node that is ready. A timer that is itself the product behavior (a countdown, a toast's lifetime, a poll, a typing debounce) needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`,
		});
	};
	let timerImports = new Set();
	let timerSpaces = new Set();
	const scheduler = (node) =>
		(node?.type === "Identifier" &&
			(timerImports.has(node.name) || (node.name === "scheduler" && !declared(context, node)))) ||
		(memberName(node) === "scheduler" &&
			node.object.type === "Identifier" &&
			(TIMER_HOSTS.has(node.object.name) || timerSpaces.has(node.object.name)));
	const own = {
		Program(program) {
			timerImports = new Set();
			timerSpaces = new Set();
			for (const s of program.body) {
				if (s.type !== "ImportDeclaration" || !TIMER_MODULES.has(s.source.value)) continue;
				for (const spec of s.specifiers)
					if (spec.type === "ImportSpecifier" && nameOf(spec.imported) === "scheduler")
						timerImports.add(spec.local.name);
					else if (spec.type !== "ImportSpecifier") timerSpaces.add(spec.local.name);
			}
		},
		Identifier(node) {
			if (TIMERS.has(node.name) && isValueReference(node) && !declared(context, node)) report(node, node.name);
		},
		MemberExpression(node) {
			const name = memberName(node);
			if (TIMERS.has(name) && node.object.type === "Identifier" && TIMER_HOSTS.has(node.object.name))
				report(node, name);
			if (name === "wait" && scheduler(node.object)) report(node, "scheduler.wait");
		},
		VariableDeclarator(node) {
			if (node.id.type !== "ObjectPattern" || node.init?.type !== "Identifier" || !TIMER_HOSTS.has(node.init.name))
				return;
			for (const p of node.id.properties) {
				const name = p.type === "Property" ? keyName(p.key, p.computed) : null;
				if (TIMERS.has(name)) report(p, name);
			}
		},
		CallExpression(node) {
			if (memberName(node.callee) !== "postTask" || !scheduler(node.callee.object)) return;
			const options = node.arguments[1];
			const delayed =
				options !== undefined &&
				(options.type !== "ObjectExpression" ||
					options.properties.some((p) => p.type !== "Property" || keyName(p.key, p.computed) === "delay"));
			if (delayed) report(node, "scheduler.postTask with a delay");
		},
	};
	return merge(
		moduleUses(REACT_DOM, new Set(["flushSync"]), [], report),
		moduleUses(TIMER_MODULES, TIMERS, [], report),
		own,
	);
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

const literalAttribute = (element, name) => {
	const attribute = element.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
	if (!attribute) return undefined;
	const value = attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value;
	return value?.type === "Literal" && typeof value.value === "string" ? value.value : null;
};

const acceptsHost = (host, element) => {
	const [, tag, required] = host.match(/^([a-z]+)(?:\[([a-z-]+)\])?$/);
	return (
		element.name.name === tag &&
		(!required || element.attributes.some((a) => a.type === "JSXAttribute" && a.name.name === required))
	);
};

const clickableHost = ratcheted("clickable-host", (context, push) => ({
	JSXOpeningElement(node) {
		if (node.name.type !== "JSXIdentifier" || !/^[a-z]/.test(node.name.name)) return;
		if (INTERACTIVE_HOSTS.some((host) => acceptsHost(host, node))) return;
		const handler = node.attributes.find((a) => a.type === "JSXAttribute" && POINTER_HANDLERS.has(a.name.name));
		if (!handler || INTERACTIVE_ROLES.includes(literalAttribute(node, "role"))) return;
		push({
			node: handler,
			fn: enclosingName(node),
			message: `${handler.name.name} on a <${node.name.name}> makes an element clickable that is not a control, so it gets no pointer cursor, focus or keyboard activation. Use a button, a link or a packages/ui primitive.`,
		});
	},
}));

const QUERY_CALLS = new Set(["query", "execute", "unsafe"]);

const isSqlTag = (tag, names) =>
	(tag.type === "Identifier" && names.has(tag.name)) ||
	(tag.type === "MemberExpression" && tag.object.type === "Identifier" && names.has(tag.object.name));

function sqlComments(parts) {
	const found = [];
	let quote = null;
	parts.forEach(({ text, node }) => {
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (quote) {
				if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"') quote = c;
			else if (c === "-" && text[i + 1] === "-") {
				const end = text.indexOf("\n", i);
				found.push({ node, at: i, text: text.slice(i, end === -1 ? text.length : end) });
				i = end === -1 ? text.length : end;
			} else if (c === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				found.push({ node, at: i, text: text.slice(i, end === -1 ? text.length : end + 2) });
				i = end === -1 ? text.length : end + 1;
			}
		}
	});
	return found;
}

const noSqlComments = ratcheted("no-sql-comments", (context, push) => {
	const check = (parts) => {
		for (const { node, at, text } of sqlComments(parts)) {
			if (sqlMarkers.has(text)) continue;
			const before = parts.find((part) => part.node === node).text.slice(0, at);
			const line = node.loc.start.line + (before.match(/\n/g)?.length ?? 0);
			push({
				loc: { start: { line, column: 0 }, end: { line, column: 0 } },
				fn: enclosingName(node),
				message:
					"A comment inside SQL ships to Postgres and is a comment all the same. Delete it; a marker that a tool reads is listed with its reason in scripts/lint/exemptions.json (sqlMarkers).",
			});
		}
	};
	const quasis = (template) => template.quasis.map((q) => ({ text: q.value.raw, node: q }));
	let tags = new Set(["sql"]);
	return {
		Program(program) {
			tags = new Set(["sql"]);
			for (const s of program.body)
				if (s.type === "ImportDeclaration")
					for (const spec of s.specifiers)
						if (spec.type === "ImportSpecifier" && nameOf(spec.imported) === "sql") tags.add(spec.local.name);
		},
		TaggedTemplateExpression(node) {
			if (isSqlTag(node.tag, tags)) check(quasis(node.quasi));
		},
		CallExpression(node) {
			const name = memberName(node.callee);
			const first = node.arguments[0];
			if (!QUERY_CALLS.has(name) && !(name === "raw" && isSqlTag(node.callee, tags))) return;
			if (first?.type === "TemplateLiteral") check(quasis(first));
			else if (first?.type === "Literal" && typeof first.value === "string")
				check([{ text: first.value, node: first }]);
		},
	};
});

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
		"no-sql-comments": noSqlComments,
	},
};
