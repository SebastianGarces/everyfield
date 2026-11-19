import { fileProblems, importProblem, resolveImport, routeFeatures } from "./boundaries.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { area, commentsExempt, ratchet, repoPath, root, sqlMarkers } from "./ratchet.mjs";

const RESEND_PACKAGE = /^resend(?:\/|$)/;
const RESEND_HOST = "api.resend.com";
const PRIVATE_CARE = /private_(?:week|calendar)|privateCare|createPrivateCare/;

const text = (node) =>
	node.type === "Literal" && typeof node.value === "string"
		? node.value
		: node.type === "TemplateElement"
			? (node.value.cooked ?? node.value.raw)
			: null;
const literalArgument = (node) =>
	node?.type === "Literal" && typeof node.value === "string"
		? node.value
		: node?.type === "TemplateLiteral" && node.expressions.length === 0
			? node.quasis[0].value.cooked
			: null;
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
		TSImportType: (node) => {
			const name = literalArgument(node.source ?? node.argument?.literal);
			if (name !== null) report(node, name);
		},
		TSImportEqualsDeclaration: (node) => {
			const reference = node.moduleReference;
			const name = reference.type === "TSExternalModuleReference" ? literalArgument(reference.expression) : null;
			if (name !== null) report(node, name);
		},
	};
}

const resendSenders = {
	meta: { type: "problem" },
	create(context) {
		const message =
			"Only the guarded senders (server/mail/transport.ts, server/jobs/resend.ts, early-access) may reach Resend: send mail through them, so mailRecipientAllowed runs first.";
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

export const TABLE_WRITERS = {
	phase_transition: {
		owner: "packages/domain/src/phases/",
		why: "the phases domain records every phase transition, including the one initial declaration a plant may make",
	},
};
const INSERT_INTO = /\binsert\s+into\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

const tableWriters = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		const report = (node, table) => {
			const { owner, why } = TABLE_WRITERS[table];
			if (!path.startsWith(owner))
				context.report({
					node,
					message: `Only ${owner} inserts into ${table}: ${why}. Call its operation instead of writing the row here.`,
				});
		};
		const check = (value, node) => {
			for (const [, table] of value?.matchAll(INSERT_INTO) ?? [])
				if (Object.hasOwn(TABLE_WRITERS, table.toLowerCase())) report(node, table.toLowerCase());
		};
		const aliases = new Map();
		const tableOf = (node) =>
			node?.type === "Identifier"
				? aliases.get(node.name)
				: node?.type === "MemberExpression" && Object.hasOwn(TABLE_WRITERS, memberName(node))
					? memberName(node)
					: undefined;
		const bind = (id, table) => {
			if (id?.type === "Identifier" && table) aliases.set(id.name, table);
		};
		return {
			Literal: (node) => check(text(node), node),
			TemplateElement: (node) => check(text(node), node),
			ImportSpecifier: (node) => {
				const imported = nameOf(node.imported);
				if (Object.hasOwn(TABLE_WRITERS, imported)) bind(node.local, imported);
			},
			VariableDeclarator: (node) => {
				if (node.id.type === "Identifier") bind(node.id, tableOf(node.init));
				if (node.id.type !== "ObjectPattern") return;
				for (const p of node.id.properties) {
					const key = p.type === "Property" ? keyName(p.key, p.computed) : null;
					if (Object.hasOwn(TABLE_WRITERS, key))
						bind(p.value.type === "AssignmentPattern" ? p.value.left : p.value, key);
				}
			},
			CallExpression: (node) => {
				const table = tableOf(node.arguments[0]);
				if (memberName(node.callee) === "insert" && table) report(node, table);
			},
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

const paramNamed = (fn, name) => fn.params?.[0]?.type === "Identifier" && fn.params[0].name === name;
const narrowsToError = (test, name) =>
	test?.type === "BinaryExpression" &&
	test.operator === "instanceof" &&
	test.left.type === "Identifier" &&
	test.left.name === name;
const knownError = (node, name) => {
	for (let at = node, child = null; at; child = at, at = at.parent) {
		if (at.type === "CatchClause" && at.param?.type === "Identifier" && at.param.name === name) return true;
		if (at.type === "LogicalExpression" && at.operator === "&&" && at.right === child && narrowsToError(at.left, name))
			return true;
		if (
			(at.type === "ArrowFunctionExpression" || at.type === "FunctionExpression") &&
			paramNamed(at, name) &&
			at.parent?.type === "CallExpression" &&
			at.parent.callee.type === "MemberExpression" &&
			at.parent.callee.property.name === "catch"
		)
			return true;
	}
	return false;
};
const errorMessage = (node) =>
	node?.type === "MemberExpression" &&
	!node.computed &&
	node.property.name === "message" &&
	node.object.type === "Identifier" &&
	knownError(node, node.object.name);
const EQUALITY = new Set(["==", "===", "!=", "!=="]);
const TEXT_MATCH = new Set(["includes", "startsWith", "endsWith"]);

const noErrorMessageMatch = {
	meta: { type: "problem" },
	create(context) {
		const message =
			"Never recognise an error by its message text: throw an error class with a typed code and test it with instanceof and .code.";
		return {
			BinaryExpression: (node) => {
				if (EQUALITY.has(node.operator) && (errorMessage(node.left) || errorMessage(node.right)))
					context.report({ node, message });
			},
			CallExpression: (node) => {
				const callee = node.callee;
				if (callee.type !== "MemberExpression" || callee.computed || !TEXT_MATCH.has(callee.property.name)) return;
				if (errorMessage(callee.object) || node.arguments.some(errorMessage)) context.report({ node, message });
			},
		};
	},
};

export const SESSION_MODULE = "packages/domain/src/access/session.ts";
const PRODUCT_SOURCE = /^(?:packages\/[^/]+\/src|apps\/web\/src)\//;

const ACTOR_CLASS = "RequestActor";
const ACTOR_STATICS = new Set(["resolve", "claimWrite"]);
const staticKey = (node) =>
	keyName(node.property, node.computed) ?? (node.computed ? literalArgument(node.property) : null);

const requestActor = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === SESSION_MODULE || !PRODUCT_SOURCE.test(path)) return {};
		const built = `Only ${SESSION_MODULE} builds a RequestActor from a session and an actor: resolve it with RequestActor.resolve or claim a write, so authority always comes from the server session.`;
		const passed = `Reach RequestActor only through a named static member (RequestActor.resolve, RequestActor.claimWrite), so only ${SESSION_MODULE} builds one from a session and an actor.`;
		const locals = new Set([ACTOR_CLASS]);
		const isClass = (node) =>
			(node.type === "Identifier" && locals.has(node.name)) ||
			(node.type === "MemberExpression" && staticKey(node) === ACTOR_CLASS);
		const throughMember = (node) => node.parent?.type === "MemberExpression" && node.parent.object === node;
		return {
			Program(program) {
				for (const s of program.body)
					if (s.type === "ImportDeclaration" && s.importKind !== "type")
						for (const spec of s.specifiers)
							if (
								spec.type === "ImportSpecifier" &&
								spec.importKind !== "type" &&
								nameOf(spec.imported) === ACTOR_CLASS
							)
								locals.add(spec.local.name);
			},
			MemberExpression(node) {
				if (isClass(node.object)) {
					const key = staticKey(node);
					if (key === null || key === "of") context.report({ node, message: built });
					else if (!ACTOR_STATICS.has(key)) context.report({ node, message: passed });
				}
				if (staticKey(node) === ACTOR_CLASS && !throughMember(node)) context.report({ node, message: passed });
			},
			Identifier(node) {
				if (locals.has(node.name) && isValueReference(node) && !throughMember(node))
					context.report({ node, message: passed });
			},
			ExportSpecifier(node) {
				const local = nameOf(node.local);
				if ((local === ACTOR_CLASS || locals.has(local)) && nameOf(node.exported) !== ACTOR_CLASS)
					context.report({ node, message: passed });
			},
			Property(node) {
				const renamed = node.value.type !== "Identifier" || node.value.name !== ACTOR_CLASS;
				if (node.parent.type === "ObjectPattern" && keyName(node.key, node.computed) === ACTOR_CLASS && renamed)
					context.report({ node, message: passed });
			},
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

const RUNTIME_MODULES =
	/^(?:react|react-dom|next|server-only|client-only|zustand|@everyfield\/db|node:)(?:\/|$)|^node:/;
const RUNTIME_GLOBALS = new Set([
	"window",
	"document",
	"navigator",
	"location",
	"history",
	"localStorage",
	"sessionStorage",
	"process",
	"fetch",
	"globalThis",
	"self",
]);
const CLOCKS = new Set(["Date", "performance"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window"]);

const modelModule = {
	meta: { type: "problem" },
	create(context) {
		const report = (node, what) =>
			context.report({
				node,
				message: `A model module is pure: it takes the clock, the browser and the server as arguments and imports none of them. Remove the ${what}.`,
			});
		const aliases = new Map();
		const clockOf = (node) => {
			if (node?.type === "Identifier") return aliases.get(node.name) ?? (CLOCKS.has(node.name) ? node.name : null);
			if (node?.type !== "MemberExpression") return null;
			const name = memberName(node);
			if (CLOCKS.has(name) && node.object.type === "Identifier" && GLOBAL_OBJECTS.has(node.object.name)) return name;
			return name === "now" && clockOf(node.object) ? "now" : null;
		};
		const sources = moduleSources((node, name) => {
			if (node.type === "TSImportType" || node.importKind === "type" || node.exportKind === "type") return;
			if (RUNTIME_MODULES.test(name) && !(node.type === "ImportDeclaration" && typeOnly(node)))
				report(node, `import of ${name}`);
		});
		return {
			...sources,
			ExpressionStatement: (node) =>
				typeof node.directive === "string" && node.directive.startsWith("use ") && report(node, `"${node.directive}"`),
			VariableDeclarator: (node) => {
				if (node.id.type === "Identifier") {
					const clock = clockOf(node.init);
					if (clock) aliases.set(node.id.name, clock);
					return;
				}
				if (node.id.type !== "ObjectPattern" || !clockOf(node.init)) return;
				for (const p of node.id.properties)
					if (p.type === "Property" && keyName(p.key, p.computed) === "now" && p.value.type === "Identifier")
						aliases.set(p.value.name, "now");
			},
			NewExpression: (node) =>
				clockOf(node.callee) === "Date" && node.arguments.length === 0 && report(node, "clock read (new Date())"),
			CallExpression: (node) => {
				if (isRequire(node)) return sources.CallExpression(node);
				const clock = clockOf(node.callee);
				if (clock === "now") report(node, "clock read (now())");
				else if (clock === "Date") report(node, "clock read (Date())");
			},
			Identifier: (node) => RUNTIME_GLOBALS.has(node.name) && isReference(node) && report(node, `use of ${node.name}`),
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
	"requestVideoFrameCallback",
]);
const TIMER_HOSTS = new Set(["window", "globalThis", "self"]);
const REACT = new Set(["react"]);
const REACT_DOM = new Set(["react-dom"]);
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"]);
const MOTION = new Set(["motion", "motion/react", "motion/react-client", "motion/mini", "motion-dom", "framer-motion"]);
const MOTION_TIMERS = new Set(["frame", "frameData", "useAnimationFrame", "delay"]);
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
const POINTER_HANDLERS = new Set(
	["onClick", "onDoubleClick", "onMouseDown", "onMouseUp", "onPointerDown", "onPointerUp"].flatMap((name) => [
		name,
		`${name}Capture`,
	]),
);
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
			if (!isModuleValue(node.init, b, sources)) return;
			if (node.id.type === "Identifier") b.spaces.add(node.id.name);
			if (node.id.type !== "ObjectPattern") return;
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

const LIFECYCLE_METHODS = new Set([
	"componentDidMount",
	"componentDidUpdate",
	"componentWillUnmount",
	"getSnapshotBeforeUpdate",
	"UNSAFE_componentWillMount",
	"UNSAFE_componentWillReceiveProps",
	"UNSAFE_componentWillUpdate",
]);
const EXISTENCE_TESTS = new Set(["IfStatement", "ConditionalExpression", "LogicalExpression", "UnaryExpression"]);

const isUseCallback = (callee) => (callee.type === "Identifier" ? callee.name : memberName(callee)) === "useCallback";

function refCallback(context, value) {
	if (value?.type === "CallExpression" && isUseCallback(value.callee)) return refCallback(context, value.arguments[0]);
	if (value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression") return value;
	if (value?.type !== "Identifier") return null;
	for (let scope = context.sourceCode.getScope(value); scope; scope = scope.upper) {
		const def = scope.set?.get(value.name)?.defs?.[0];
		if (!def) continue;
		if (def.node.type === "FunctionDeclaration") return def.node;
		return def.node.type === "VariableDeclarator" ? refCallback(context, def.node.init) : null;
	}
	return null;
}

const isNothing = (node) =>
	(node?.type === "Literal" && node.value === null && node.raw === "null") ||
	(node?.type === "Identifier" && node.name === "undefined");

const onlyTested = (reference) => {
	const id = reference.identifier;
	const p = id.parent;
	if (p?.type === "UnaryExpression") return p.operator === "!";
	if (p?.type === "BinaryExpression" && EQUALITY.has(p.operator)) return isNothing(p.left === id ? p.right : p.left);
	return EXISTENCE_TESTS.has(p?.type) && (p.test === id || (p.type === "LogicalExpression" && p.left === id));
};

const noEffects = ratcheted("no-effects", (context, push) => {
	const report = (node, message) => push({ node, fn: enclosingName(node), message });
	const banned = (name) =>
		`${name} is banned. Derive the value while rendering, do the work in the event handler that causes it, reset state with a key, or subscribe with useSyncExternalStore. An effect that no other pattern can replace needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`;
	const lifecycle = (node) => {
		const name = keyName(node.key, node.computed);
		if (LIFECYCLE_METHODS.has(name)) report(node, `${name} is a class component's effect: ${banned(name)}`);
	};
	return merge(
		moduleUses(
			REACT,
			EFFECT_HOOKS,
			["React"],
			(node, name) =>
				report(
					node,
					name.startsWith("import(")
						? `${name} hides which hooks the code uses. Import from react statically.`
						: banned(name),
				),
			true,
		),
		{
			MethodDefinition: lifecycle,
			PropertyDefinition: lifecycle,
			JSXAttribute(node) {
				if (node.name.name !== "ref" || node.value?.type !== "JSXExpressionContainer") return;
				const fn = refCallback(context, node.value.expression);
				if (!fn) return;
				const [param] = fn.params;
				const variable =
					param?.type === "Identifier"
						? context.sourceCode.getDeclaredVariables(fn).find((v) => v.name === param.name)
						: null;
				if (param && (!variable || !variable.references.every(onlyTested))) return;
				report(
					node,
					"A ref callback that never uses its node is a mount effect: it runs when the element attaches, whatever the work is. Do the work in the event that causes it, or derive it while rendering; a ref callback holds only logic about that DOM node.",
				);
			},
		},
	);
});

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

const emptyResolve = (node) =>
	node?.type === "CallExpression" &&
	node.arguments.length === 0 &&
	memberName(node.callee) === "resolve" &&
	node.callee.object.type === "Identifier" &&
	node.callee.object.name === "Promise";
const tickOnly = (node) =>
	node.type === "Literal" ||
	(node.type === "Identifier" && node.name === "undefined") ||
	(node.type === "UnaryExpression" && node.operator === "void") ||
	emptyResolve(node);

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
			if (TIMERS.has(name)) report(node, name);
			if ((name === "wait" || name === "yield") && scheduler(node.object)) report(node, `scheduler.${name}`);
		},
		AwaitExpression(node) {
			if (tickOnly(node.argument)) report(node, "await of a value that is already there");
		},
		VariableDeclarator(node) {
			if (node.id.type !== "ObjectPattern") return;
			for (const p of node.id.properties) {
				const name = p.type === "Property" ? keyName(p.key, p.computed) : null;
				if (TIMERS.has(name)) report(p, name);
			}
		},
		CallExpression(node) {
			if (CHAIN.has(memberName(node.callee) ?? "") && emptyResolve(node.callee.object))
				return report(node, "Promise.resolve().then");
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
		moduleUses(MOTION, MOTION_TIMERS, [], (node, name) => report(node, `${name} from motion`)),
		own,
	);
});

export const STORAGE_MODULE = "packages/db/src/schema/storage.ts";
const OBJECT_STORE_PACKAGE = /^@aws-sdk(?:\/|$)/;
const PRODUCT_CODE = /^(?:packages\/[^/]+\/src|apps\/web\/src)\//;

const storageClient = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === STORAGE_MODULE || !PRODUCT_CODE.test(path)) return {};
		const message = `Only ${STORAGE_MODULE} reaches the object store and signs its URLs: the browser gets the app's own authenticated routes, never a storage key or a signed URL.`;
		return moduleSources((node, name) => {
			if (OBJECT_STORE_PACKAGE.test(name)) context.report({ node, message });
		});
	},
};

export const LOCATION_STORE = "apps/web/src/components/location.ts";
export const ONE_TIME_LINK = "apps/web/src/components/one-time-link.ts";
export const PAGE_EVENTS = "apps/web/src/components/save/leave.ts";
const HISTORY_MEMBERS = new Set(["pushState", "replaceState", "onpopstate"]);
const HISTORY_STRINGS = new Set(["pushState", "replaceState", "popstate", "onpopstate", "currententrychange"]);
const GLOBAL_HOSTS = new Set(["window", "globalThis", "self"]);

const stringValue = (node) =>
	node?.type === "Literal" && typeof node.value === "string"
		? node.value
		: node?.type === "TemplateLiteral" && node.expressions.length === 0
			? (node.quasis[0]?.value.cooked ?? null)
			: null;
const isHost = (node, context, names) =>
	node?.type === "Identifier" && names.has(node.name) && !declared(context, node);
const isHistory = (node, context) =>
	isHost(node, context, new Set(["history"])) ||
	(memberName(node) === "history" && isHost(node.object, context, GLOBAL_HOSTS));
const LINK_VALUE_ENTRY = /path: "(\/[^"]+)",\s*part: "(query|fragment)",\s*param: (?:null|"([^"]+)")/g;
const LINK_REGISTRY = new URL(`../../${ONE_TIME_LINK}`, import.meta.url);
const LINK_VALUES = [
	...(existsSync(LINK_REGISTRY) ? readFileSync(LINK_REGISTRY, "utf8") : "").matchAll(LINK_VALUE_ENTRY),
].map(([, path, part, param]) => ({ path, part, param }));
const carriesLinkValue = (text) =>
	LINK_VALUES.some(({ path, part, param }) => {
		if (!text.startsWith(path) || !/^[?#]/.test(text.slice(path.length))) return false;
		const [beforeHash, ...hash] = text.split("#");
		if (part === "fragment") return hash.length > 0;
		return new RegExp(`[?&]${param}=`).test(beforeHash);
	});
const isLocation = (node, context) =>
	isHost(node, context, new Set(["location"])) ||
	(memberName(node) === "location" && isHost(node.object, context, new Set([...GLOBAL_HOSTS, "document"])));
const isNavigation = (node, context) =>
	isHost(node, context, new Set(["navigation"])) ||
	(memberName(node) === "navigation" && isHost(node.object, context, GLOBAL_HOSTS));

const PLACEHOLDER = "\u0000";
const ORIGIN = /^(?:\u0000+|[a-z][a-z\d+.-]*:\/\/[^/?#]*|\/\/[^/?#]*)(?=\/)/i;
const queryText = (names) => [...names].map((name) => `${name}=${PLACEHOLDER}`).join("&");
const initNames = (node) => {
	if (node?.type === "ObjectExpression")
		return node.properties.flatMap((p) => (p.type === "Property" ? [keyName(p.key, p.computed) ?? PLACEHOLDER] : []));
	if (node?.type === "ArrayExpression")
		return node.elements.flatMap((e) =>
			e?.type === "ArrayExpression" ? [stringValue(e.elements[0]) ?? PLACEHOLDER] : [],
		);
	return [];
};
const isNew = (node, name) =>
	node?.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === name;
const isAddressRoot = (node) =>
	!(node.parent?.type === "BinaryExpression" && node.parent.operator === "+") &&
	node.parent?.type !== "TemplateLiteral";
const MAIL_BUILDERS = /^apps\/web\/src\/server\//;

const noRawHistory = ratcheted("no-raw-history", (context, push) => {
	const path = repoPath(context.filename);
	if ([LOCATION_STORE, ONE_TIME_LINK].includes(path)) return {};
	const report = (node, word) =>
		push({
			node,
			fn: enclosingName(node),
			message: `${word} outside ${LOCATION_STORE}: the address has one owner. Write it with writeAddress, read it with usePath or useAddress, read a one-time link value with useOneTimeLinkValue, react to Back and Forward with an address rule or onTraversal, so every reader sees the same address in the same event.`,
		});
	const queries = new Map();
	const urls = new Map();
	const addresses = [];
	const builds = [];
	const addressText = (node) => {
		if (node.type === "Literal") return typeof node.value === "string" ? node.value : PLACEHOLDER;
		if (node.type === "TemplateLiteral")
			return node.quasis
				.map((q, i) => (i ? addressText(node.expressions[i - 1]) : "") + (q.value.cooked ?? ""))
				.join("");
		if (node.type === "BinaryExpression" && node.operator === "+")
			return addressText(node.left) + addressText(node.right);
		if (node.type === "Identifier" && queries.has(node.name)) return queryText(queries.get(node.name));
		if (node.type === "CallExpression" && memberName(node.callee) === "toString")
			return addressText(node.callee.object);
		if (isNew(node, "URLSearchParams")) return queryText(initNames(node.arguments[0]));
		return PLACEHOLDER;
	};
	const linkAddress = (node, text) => {
		if (MAIL_BUILDERS.test(path)) return;
		if (carriesLinkValue(text.replace(ORIGIN, "")))
			report(node, "an in-app address with a one-time link value (only an emailed link may carry one)");
	};
	const objectAddress = (node) => {
		const parts = new Map(
			node.properties.flatMap((p) => (p.type === "Property" ? [[keyName(p.key, p.computed), p.value]] : [])),
		);
		const pathname = parts.get("pathname");
		if (!pathname) return null;
		const query = parts.get("query") ?? parts.get("searchParams");
		const names = query ? (query.type === "ObjectExpression" ? initNames(query) : [PLACEHOLDER]) : [];
		const search = parts.get("search") ? addressText(parts.get("search")) : "";
		const hash = parts.get("hash") ? `#${addressText(parts.get("hash"))}` : "";
		return `${addressText(pathname)}${names.length ? `?${queryText(names)}` : search}${hash}`;
	};
	const urlWrite = (node, name, text) => {
		const url = urls.get(name);
		if (!url) return;
		url.text += text;
		builds.push({ node, text: url.text });
	};
	const urlOf = (node) => (node?.type === "Identifier" && urls.has(node.name) ? node.name : null);
	return {
		MemberExpression(node) {
			const name = memberName(node);
			if (name && HISTORY_MEMBERS.has(name)) return report(node, name);
			if (name === "hash" && isLocation(node.object, context)) return report(node, "location.hash");
			if (node.computed && name === null && isHistory(node.object, context)) return report(node, "history[...]");
			if (isNavigation(node, context) || isNavigation(node.object, context)) report(node, "the Navigation API");
		},
		Property(node) {
			if (node.parent?.type !== "ObjectPattern") return;
			const name = keyName(node.key, node.computed);
			if (name && HISTORY_MEMBERS.has(name)) report(node, name);
		},
		Literal(node) {
			const value = stringValue(node);
			if (value && HISTORY_STRINGS.has(value) && memberName(node.parent) === null) report(node, value);
			if (typeof node.value === "string" && isAddressRoot(node)) addresses.push(node);
		},
		TemplateLiteral(node) {
			const value = stringValue(node);
			if (value && HISTORY_STRINGS.has(value)) report(node, value);
			if (isAddressRoot(node)) addresses.push(node);
		},
		BinaryExpression(node) {
			if (node.operator === "+" && isAddressRoot(node)) addresses.push(node);
		},
		ObjectExpression(node) {
			builds.push({ node, object: true });
		},
		NewExpression(node) {
			const target = node.parent?.type === "VariableDeclarator" ? node.parent.id : null;
			if (target?.type !== "Identifier") return;
			if (isNew(node, "URLSearchParams")) queries.set(target.name, new Set(initNames(node.arguments[0])));
			if (isNew(node, "URL") && node.arguments[0])
				urls.set(target.name, { text: addressText(node.arguments[0]).replace(ORIGIN, "") });
		},
		CallExpression(node) {
			const method = memberName(node.callee);
			if (method !== "set" && method !== "append") return;
			const param = stringValue(node.arguments[0]) ?? PLACEHOLDER;
			const owner = node.callee.object;
			if (owner.type === "Identifier" && queries.has(owner.name)) queries.get(owner.name).add(param);
			const url = memberName(owner) === "searchParams" ? urlOf(owner.object) : null;
			if (url) urlWrite(node, url, `${urls.get(url).text.includes("?") ? "&" : "?"}${param}=${PLACEHOLDER}`);
		},
		AssignmentExpression(node) {
			const part = memberName(node.left);
			const url = urlOf(node.left.object);
			if (!url || (part !== "hash" && part !== "search")) return;
			const text = addressText(node.right);
			urlWrite(node, url, part === "hash" ? `#${text.replace(/^#/, "")}` : `?${text.replace(/^\?/, "")}`);
		},
		VariableDeclarator(node) {
			if (node.id.type !== "ObjectPattern" || !isLocation(node.init, context)) return;
			for (const p of node.id.properties)
				if (p.type === "Property" && keyName(p.key, p.computed) === "hash") report(p, "location.hash");
		},
		"Program:exit"() {
			for (const node of addresses) linkAddress(node, addressText(node));
			for (const build of builds) {
				const text = build.object ? objectAddress(build.node) : build.text;
				if (text !== null) linkAddress(build.node, text);
			}
		},
	};
});

const GLOBAL_LISTENER_OWNERS = new Set([LOCATION_STORE, PAGE_EVENTS]);
const LISTENER_MEMBERS = new Set(["addEventListener", "removeEventListener"]);
const LISTENER_HOSTS = new Set([...GLOBAL_HOSTS, "document"]);
const HOST_MEMBERS = new Set(["document", "body", "documentElement", "ownerDocument", "defaultView", "visualViewport"]);
const ON_HANDLER = /^on[a-z]+$/;
const REGISTRY_WORDS = new Set(["onTraversal", "onNavigation", "addAddressRule"]);
const OBSERVER = /^[A-Z]\w*Observer$/;
const isMediaQuery = (call) =>
	(call.callee.type === "Identifier" ? call.callee.name : memberName(call.callee)) === "matchMedia";

function isJsxRef(fn) {
	let node = fn.parent;
	if (node?.type === "JSXExpressionContainer") node = node.parent;
	return node?.type === "JSXAttribute" && node.name.name === "ref";
}

const noGlobalListeners = ratcheted("no-global-listeners", (context, push) => {
	if (GLOBAL_LISTENER_OWNERS.has(repoPath(context.filename))) return {};
	const aliases = new Set();
	const report = (node, name) =>
		push({
			node,
			fn: enclosingName(node),
			message: `${name}: page-wide events have one owner each. Address changes go through ${LOCATION_STORE} (an address rule registered at module scope, or onTraversal started from an event); shortcuts, the unsaved-work warning, the leave hold and the last write when the page is hidden go through ${PAGE_EVENTS} (shortcutMark on the form or control, unsavedMark or leaveHoldMark on the form, leaveBeaconMark on the element that holds the write). A listener tied to a component's lifetime is an effect: it needs a survivor entry.`,
		});
	const isPageNode = (node) => {
		for (let at = node; at; at = at.type === "MemberExpression" ? at.object : at.expression) {
			if (["ownerDocument", "defaultView"].includes(memberName(at))) return true;
			if (at.type === "Identifier") return isHost(at, context, LISTENER_HOSTS) || aliases.has(at.name);
			if (!["MemberExpression", "ChainExpression", "TSNonNullExpression", "TSAsExpression"].includes(at.type))
				return false;
		}
		return false;
	};
	const isGlobalHost = (node) => {
		if (node?.type === "ConditionalExpression") return isGlobalHost(node.consequent) || isGlobalHost(node.alternate);
		if (node?.type === "LogicalExpression") return isGlobalHost(node.left) || isGlobalHost(node.right);
		if (node?.type === "SequenceExpression") return isGlobalHost(node.expressions.at(-1));
		if (node?.type === "ChainExpression") return isGlobalHost(node.expression);
		if (
			node?.type === "TSAsExpression" ||
			node?.type === "TSNonNullExpression" ||
			node?.type === "TSSatisfiesExpression"
		)
			return isGlobalHost(node.expression);
		if (node?.type === "CallExpression") return isMediaQuery(node);
		return (
			isHost(node, context, LISTENER_HOSTS) ||
			(node?.type === "Identifier" && aliases.has(node.name)) ||
			HOST_MEMBERS.has(memberName(node) ?? "")
		);
	};
	return {
		VariableDeclarator(node) {
			if (node.id.type === "Identifier" && isGlobalHost(node.init)) aliases.add(node.id.name);
			if (node.id.type !== "ObjectPattern" || !isGlobalHost(node.init)) return;
			for (const p of node.id.properties) {
				const name = p.type === "Property" ? keyName(p.key, p.computed) : null;
				if (name && (LISTENER_MEMBERS.has(name) || ON_HANDLER.test(name))) report(p, name);
			}
		},
		AssignmentExpression(node) {
			if (node.left.type === "Identifier" && isGlobalHost(node.right)) aliases.add(node.left.name);
		},
		MemberExpression(node) {
			const name = memberName(node);
			if (!name || !(LISTENER_MEMBERS.has(name) || ON_HANDLER.test(name))) return;
			if (isGlobalHost(node.object)) report(node, `${name} on window or document`);
		},
		Identifier(node) {
			if (node.name !== "addEventListener" || !isValueReference(node) || declared(context, node)) return;
			if (node.parent?.type === "MemberExpression" && node.parent.property === node) return;
			report(node, "addEventListener");
		},
		NewExpression(node) {
			if (node.callee.type === "Identifier" && OBSERVER.test(node.callee.name) && atModuleLevel(node))
				report(node, `a ${node.callee.name} created at module load`);
		},
		CallExpression(node) {
			const name = node.callee.type === "Identifier" ? node.callee.name : memberName(node.callee);
			if (name === "observe" && node.callee.type === "MemberExpression" && isPageNode(node.arguments[0]))
				return report(node, "an observer of the whole document");
			if (!REGISTRY_WORDS.has(name)) return;
			if (name === "addAddressRule") {
				if (!atModuleLevel(node))
					report(node, "addAddressRule outside module scope (it would add a rule on every render)");
				return;
			}
			const fn = nearestFunction(node);
			const owner = fn && functionName(fn);
			if (fn && (isJsxRef(fn) || (owner && /^([A-Z]|use[A-Z0-9])/.test(owner))))
				report(node, `${name} registered for a component's lifetime`);
		},
	};
});

export const STORE_HELPER = "apps/web/src/components/store.ts";
export const MODULE_STORES = ["apps/web/src/features/meetings/deletions.store.ts"];
const ZUSTAND = /^zustand(?:\/|$)/;
const STORE_FACTORY = /^create\w*Store$/;

function atModuleLevel(node) {
	for (let p = node.parent; p; p = p.parent) {
		if (!FUNCTIONS.has(p.type)) continue;
		const call = p.parent;
		const iife = call?.type === "CallExpression" && call.callee === p;
		if (!iife) return false;
	}
	return true;
}

const zustandShape = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		const storeFile = path.endsWith(".store.ts");
		const report = (node, message) => context.report({ node, message });
		const allowed = (source) =>
			source === "zustand/vanilla"
				? storeFile
				: path === STORE_HELPER && (source === "zustand" || source === "zustand/react/shallow");
		const factories = new Set();
		const spaces = new Set();
		const storeSpaces = new Set();
		const sources = moduleSources((node, source) => {
			if (!ZUSTAND.test(source)) return;
			if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && path !== STORE_HELPER)
				return report(
					node,
					`${source} is not re-exported. Import it where it is used: store files take createStore from zustand/vanilla; components use ${STORE_HELPER}.`,
				);
			if (!allowed(source))
				report(
					node,
					`${source} is not imported here. A store file (<Component>.store.ts) imports createStore from zustand/vanilla only; components read it through useLocalStore, useStore and storeContext from ${STORE_HELPER}. No module-level create(), no middleware.`,
				);
		});
		const isFactory = (callee) =>
			(callee?.type === "Identifier" && factories.has(callee.name)) ||
			(callee?.type === "MemberExpression" &&
				callee.object.type === "Identifier" &&
				((spaces.has(callee.object.name) && memberName(callee) === "createStore") ||
					(storeSpaces.has(callee.object.name) && STORE_FACTORY.test(memberName(callee) ?? ""))));
		return {
			...sources,
			ImportDeclaration(node) {
				sources.ImportDeclaration(node);
				const source = node.source.value;
				const vanilla = source === "zustand/vanilla";
				const storeModule = /\.store(\.ts)?$/.test(source);
				if (!vanilla && !storeModule) return;
				for (const spec of node.specifiers) {
					if (spec.type === "ImportNamespaceSpecifier") (vanilla ? spaces : storeSpaces).add(spec.local.name);
					else if (spec.type === "ImportSpecifier") {
						const name = nameOf(spec.imported);
						if ((vanilla && name === "createStore") || (storeModule && STORE_FACTORY.test(name)))
							factories.add(spec.local.name);
					}
				}
			},
			VariableDeclarator(node) {
				if (node.id.type !== "Identifier") return;
				if (node.init?.type === "Identifier" && factories.has(node.init.name)) factories.add(node.id.name);
				if (storeFile && STORE_FACTORY.test(node.id.name)) factories.add(node.id.name);
			},
			FunctionDeclaration(node) {
				if (storeFile && node.id && STORE_FACTORY.test(node.id.name)) factories.add(node.id.name);
			},
			CallExpression(node) {
				sources.CallExpression(node);
				if (MODULE_STORES.includes(path) || !isFactory(node.callee) || !atModuleLevel(node)) return;
				report(
					node,
					"A store is created per component instance: export a create<Name>Store(init) function and call it from useLocalStore. A module-level store is shared by every request during server rendering.",
				);
			},
		};
	},
};

const MUTATORS = new Set([
	"set",
	"add",
	"delete",
	"clear",
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"sort",
	"reverse",
	"fill",
	"copyWithin",
	"setState",
	"seed",
]);
const RENDER_CALLBACKS = {
	useState: [0],
	useReducer: [0, 2],
	useMemo: [0],
	useLocalStore: [0],
	useSyncExternalStore: [1, 2],
};

const ITERATORS = new Set([
	"forEach",
	"map",
	"flatMap",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"some",
	"every",
	"reduce",
	"reduceRight",
]);
const iterationCall = (fn) => {
	const call = fn?.parent;
	return call?.type === "CallExpression" && call.arguments.includes(fn) && ITERATORS.has(memberName(call.callee) ?? "")
		? call
		: null;
};
const callerOf = (node) => {
	let fn = nearestFunction(node);
	for (let call = iterationCall(fn); call; call = iterationCall(fn)) fn = nearestFunction(call);
	return fn;
};

const ROUTE_HANDLERS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const renders = (name, jsx) =>
	/^use[A-Z0-9]/.test(name) || (jsx && !ROUTE_HANDLERS.has(name) && (name === "default" || /^[A-Z]/.test(name)));

function rendering(node, jsx) {
	const fn = callerOf(node);
	if (!fn) return false;
	const name = functionName(fn);
	if (name && renders(name, jsx)) return true;
	const call = fn.parent;
	const hook =
		call?.type === "CallExpression"
			? call.callee.type === "Identifier"
				? call.callee.name
				: memberName(call.callee)
			: null;
	return Boolean(RENDER_CALLBACKS[hook]?.includes(call.arguments.indexOf(fn))) && rendering(call, jsx);
}

const rootObject = (node) => {
	let at = node;
	while (at?.type === "MemberExpression" || at?.type === "ChainExpression" || at?.type === "TSNonNullExpression")
		at = at.type === "MemberExpression" ? at.object : at.expression;
	return at?.type === "Identifier" ? at : null;
};

function moduleBinding(context, id) {
	if (!id) return null;
	for (let scope = context.sourceCode.getScope(id); scope; scope = scope.upper) {
		const variable = scope.set?.get(id.name);
		if (variable?.defs?.length) return scope.type === "module" || scope.type === "global" ? variable : null;
	}
	return null;
}

const noRenderWrites = ratcheted("no-render-writes", (context, push) => {
	const writes = [];
	const calls = [];
	const target = (node) => (node.type === "Identifier" ? node : rootObject(node));
	const write = (node, at, what) => {
		const variable = moduleBinding(context, at);
		if (variable) writes.push({ node, what: what ?? variable.name });
	};
	return {
		AssignmentExpression: (node) => write(node, target(node.left)),
		UpdateExpression: (node) => write(node, target(node.argument)),
		UnaryExpression: (node) => node.operator === "delete" && write(node, rootObject(node.argument)),
		CallExpression(node) {
			const name = memberName(node.callee);
			if (name && MUTATORS.has(name))
				write(node, rootObject(node.callee.object), `${rootObject(node.callee.object)?.name}.${name}`);
			if (node.callee.type === "Identifier") calls.push(node);
		},
		"Program:exit"() {
			const writers = new Map();
			const owner = (node) => {
				const fn = callerOf(node);
				const named = fn?.parent?.type === "VariableDeclarator" ? fn.parent.id : fn?.id;
				return named && moduleBinding(context, named) ? named.name : null;
			};
			for (const { node, what } of writes) {
				const name = owner(node);
				if (name && !writers.has(name)) writers.set(name, what);
			}
			for (let grew = true; grew;) {
				grew = false;
				for (const call of calls) {
					const name = owner(call);
					const callee = writers.get(call.callee.name);
					if (name && callee && !writers.has(name) && moduleBinding(context, call.callee)) {
						writers.set(name, callee);
						grew = true;
					}
				}
			}
			const report = (node, what) =>
				push({
					node,
					fn: enclosingName(node),
					message: `${what} writes module state while rendering. A render can run on the server for every request and is thrown away whenever React discards it, so the write leaks between users and leaves a trace of a render that never showed. Keep the value in the component's store or state, and write it in the event that changes it.`,
				});
			const jsx = /\.[jt]sx$/.test(context.filename);
			for (const { node, what } of writes) if (rendering(node, jsx)) report(node, what);
			for (const call of calls) {
				const what = writers.get(call.callee.name);
				if (what && moduleBinding(context, call.callee) && rendering(call, jsx))
					report(call, `${call.callee.name} (through ${what})`);
			}
		},
	};
});

const CHAIN = new Set(["then", "catch", "finally"]);
const mapsOnly = (fn) =>
	fn === undefined ||
	((fn.type === "ArrowFunctionExpression" || fn.type === "Identifier") && fn.body?.type !== "BlockStatement");

function loadsOnly(node) {
	let call = node;
	while (call?.type === "CallExpression" && CHAIN.has(memberName(call.callee) ?? "")) {
		if (!call.arguments.every(mapsOnly)) return false;
		call = call.callee.object;
	}
	return call?.type === "CallExpression" && call.callee.type !== "SequenceExpression";
}

const readLoader = {
	meta: { type: "problem" },
	create(context) {
		return {
			CallExpression(node) {
				if (node.callee.type !== "Identifier" || !["createRead", "useLocalRead"].includes(node.callee.name)) return;
				const loader = node.arguments[0];
				if (!loader || loader.type === "Identifier") return;
				const fine =
					(loader.type === "ArrowFunctionExpression" || loader.type === "FunctionExpression") &&
					loader.body.type !== "BlockStatement" &&
					loadsOnly(loader.body);
				if (!fine)
					context.report({
						node: loader,
						message:
							"A createRead or useLocalRead loader only loads its key: one call of a server read or fetch, optionally mapped with then/catch/finally arrows that return a value. Anything else (marking read, navigation, focus, a timer, a write) would run once per key when the first reader subscribes, a mount hook with no cleanup.",
					});
			},
		};
	},
};

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

const hostTag = (name) =>
	name.type === "JSXIdentifier" ? name.name : name.type === "JSXMemberExpression" ? name.property.name : null;

const acceptsHost = (host, element) => {
	const [, tag, required] = host.match(/^([a-z]+)(?:\[([a-z-]+)\])?$/);
	return (
		hostTag(element.name) === tag &&
		(!required || element.attributes.some((a) => a.type === "JSXAttribute" && a.name.name === required))
	);
};

const clickableHost = ratcheted("clickable-host", (context, push) => ({
	JSXOpeningElement(node) {
		const tag = hostTag(node.name);
		if (!tag || !/^[a-z]/.test(tag)) return;
		if (INTERACTIVE_HOSTS.some((host) => acceptsHost(host, node))) return;
		const handler = node.attributes.find((a) => a.type === "JSXAttribute" && POINTER_HANDLERS.has(a.name.name));
		if (!handler || INTERACTIVE_ROLES.includes(literalAttribute(node, "role"))) return;
		push({
			node: handler,
			fn: enclosingName(node),
			message: `${handler.name.name} on a <${tag}> makes an element clickable that is not a control, so it gets no pointer cursor, focus or keyboard activation. Use a button, a link or a packages/ui primitive.`,
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

const READ_ROUTE = /^apps\/web\/src\/app\/(?:.+\/)?(?:page\.tsx|layout\.tsx|route\.ts)$/;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SERVER_ACTIONS = /^\s*["']use server["']/;

const exportedNames = (statement) =>
	statement.type !== "ExportNamedDeclaration"
		? []
		: statement.declaration
			? statement.declaration.type === "VariableDeclaration"
				? statement.declaration.declarations.map((d) => d.id.name)
				: [statement.declaration.id?.name]
			: statement.specifiers.map((s) => nameOf(s.exported));

const isServerActions = (path) => {
	try {
		return SERVER_ACTIONS.test(readFileSync(join(root, path), "utf8"));
	} catch {
		return false;
	}
};

const routeReads = {
	meta: { type: "problem" },
	create(context) {
		const from = repoPath(context.filename);
		if (!READ_ROUTE.test(from)) return {};
		const imports = [];
		return {
			...moduleSources((node, spec) => imports.push([node, spec])),
			"Program:exit"(program) {
				if (program.body.some((s) => exportedNames(s).some((name) => WRITE_METHODS.has(name)))) return;
				for (const [node, spec] of imports) {
					const to = resolveImport(from, spec).to;
					if (to && isServerActions(to))
						context.report({
							node,
							message: `A page, a layout and a GET route handler only read, so they never import a server action module (${spec} starts with "use server"). Read through the feature's routes or read module, and let it hand the action to the client as a prop.`,
						});
				}
			},
		};
	},
};

const PER_REQUEST_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const segmentDefault = (path, program, name, value) => {
	if (name === "runtime") return value === "nodejs";
	if (name !== "dynamic") return false;
	if (value === "auto") return true;
	if (value !== "force-dynamic") return false;
	if (/\/(?:page|layout)\.tsx$/.test(path)) return path.startsWith("apps/web/src/app/(product)/");
	return (
		path.includes("/[") ||
		program.body.some((s) => exportedNames(s).some((exported) => PER_REQUEST_METHODS.has(exported)))
	);
};

const routeSegmentDefaults = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!path.startsWith("apps/web/src/app/")) return {};
		return {
			"Program:exit"(program) {
				for (const statement of program.body) {
					if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration")
						continue;
					for (const d of statement.declaration.declarations) {
						if (d.id.type !== "Identifier" || d.init?.type !== "Literal") continue;
						if (!segmentDefault(path, program, d.id.name, d.init.value)) continue;
						context.report({
							node: d,
							message: `export const ${d.id.name} = ${JSON.stringify(d.init.value)} repeats Next's default here: nodejs is the default runtime, every page under (product) is dynamic because the product layout reads cookies, and a route handler with a dynamic segment or a non-GET method runs per request. Delete it.`,
						});
					}
				}
			},
		};
	},
};

const MODULE_DIRECTIVE = /^\s*["']use (?:server|client)["']/;
const ROUTE_MODULE = /^apps\/web\/src\/(?:app\/.+\/(?:page|layout|route)\.tsx?|features\/.+\/routes\.tsx?)$/;

const renderReads = {
	meta: { type: "problem" },
	create(context) {
		const from = repoPath(context.filename);
		if (!from.startsWith("apps/web/src/") || MODULE_DIRECTIVE.test(context.sourceCode.text)) return {};
		let server = ROUTE_MODULE.test(from);
		const actions = new Set();
		const calls = [];
		return {
			ImportDeclaration(node) {
				if (node.source.value === "server-only") server = true;
				if (node.importKind === "type") return;
				const to = resolveImport(from, node.source.value).to;
				if (!to || !isServerActions(to)) return;
				for (const s of node.specifiers) if (s.importKind !== "type") actions.add(s.local.name);
			},
			CallExpression(node) {
				const callee = node.callee.type === "MemberExpression" ? node.callee.object : node.callee;
				if (callee.type === "Identifier") calls.push([node, callee.name]);
			},
			"Program:exit"() {
				if (!server) return;
				for (const [node, name] of calls)
					if (actions.has(name))
						context.report({
							node,
							message: `Server code calls ${name}, a server action. Actions are the client's mutation endpoint and Next runs them one at a time; call the server function the action wraps instead.`,
						});
			},
		};
	},
};

export default {
	meta: { name: "everyfield" },
	rules: {
		"resend-senders": resendSenders,
		"private-care-scope": privateCareScope,
		"pure-module": pureModule,
		"model-module": modelModule,
		"no-inner-html": noInnerHtml,
		"no-effects": noEffects,
		"table-writers": tableWriters,
		"max-state": maxState,
		"no-timers": noTimers,
		"request-actor": requestActor,
		"no-comments": noComments,
		"clickable-host": clickableHost,
		"storage-client": storageClient,
		"no-cursor-utility": noCursorUtility,
		"no-raw-history": noRawHistory,
		"no-global-listeners": noGlobalListeners,
		"zustand-shape": zustandShape,
		"read-loader": readLoader,
		"no-render-writes": noRenderWrites,
		"feature-boundaries": featureBoundaries,
		"no-sql-comments": noSqlComments,
		"no-error-message-match": noErrorMessageMatch,
		"route-reads": routeReads,
		"route-segment-defaults": routeSegmentDefaults,
		"render-reads": renderReads,
	},
};
