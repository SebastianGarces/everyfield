import { fileProblems, importProblem, resolveImport, routeFeatures } from "./boundaries.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { area, commentsExempt, ratchet, repoPath, root, sqlMarkers } from "./ratchet.mjs";
import {
	COUNTER_TEXT,
	MARKETING_STEP,
	SCOPE,
	TIME_NAME,
	classProblems,
	isMarketing,
	headingLike,
	labelLike,
	marketingMessage,
	message as slopMessage,
	styleProblems,
} from "./slop-styling.mjs";

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

const TABLE_WRITERS = {
	phase_transition: {
		owner: "packages/domain/src/phases/",
		why: "the phases domain records every phase transition, including the one initial declaration a plant may make",
	},
	job: {
		owner: "packages/domain/src/jobs/queue.ts",
		why: "the job queue owns the row shape, the dedupe key and the conflict rule; build the insert with queueJobsFor or enqueueJobs",
	},
};
const INSERT_INTO = /\b(?:insert|merge)\s+into\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const INSERT_INTO_END = /\b(?:insert|merge)\s+into\s+(?:"?public"?\.)?$/i;
const UNSEEN =
	"This rule cannot follow a table returned by a helper from another module or passed in as an untyped value; review catches those.";

const tableWriters = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		const report = (node, table) => {
			const { owner, why } = TABLE_WRITERS[table];
			if (!path.startsWith(owner))
				context.report({
					node,
					message: `Only ${owner} inserts into ${table}: ${why}. Call its operation instead of writing the row here. ${UNSEEN}`,
				});
		};
		const tableName = (name) =>
			typeof name === "string" && Object.hasOwn(TABLE_WRITERS, name.toLowerCase()) ? name.toLowerCase() : undefined;
		const check = (value, node) => {
			for (const [, table] of value?.matchAll(INSERT_INTO) ?? []) if (tableName(table)) report(node, tableName(table));
		};
		const aliases = new Map();
		const returners = new Map();
		const pending = [];
		const tableOf = (raw) => {
			const node = unwrapped(raw);
			if (node?.type === "Identifier") return aliases.get(node.name);
			if (node?.type === "MemberExpression") return tableName(memberName(node));
			if (node?.type === "CallExpression") {
				const callee = unwrapped(node.callee);
				if (callee?.type === "Identifier") return returners.get(callee.name);
				if (["raw", "identifier"].includes(memberName(callee))) return tableName(literalArgument(node.arguments[0]));
			}
			if (node?.type === "Literal") return tableName(text(node));
			return undefined;
		};
		const bind = (id, table) => {
			if (id?.type === "Identifier" && table) aliases.set(id.name, table);
		};
		const returned = (fn) =>
			fn.body.type !== "BlockStatement"
				? [fn.body]
				: fn.body.body.filter((s) => s.type === "ReturnStatement").map((s) => s.argument);
		const bindReturner = (id, fn) => {
			const table = returned(fn).map(tableOf).find(Boolean);
			if (id?.type === "Identifier" && table) returners.set(id.name, table);
		};
		return {
			Literal: (node) => check(text(node), node),
			TemplateElement: (node) => check(text(node), node),
			TemplateLiteral: (node) =>
				node.quasis.forEach((quasi, i) => {
					if (i < node.expressions.length && INSERT_INTO_END.test(text(quasi) ?? ""))
						pending.push([node.expressions[i], node]);
				}),
			ImportSpecifier: (node) => bind(node.local, tableName(nameOf(node.imported))),
			ExportSpecifier: (node) => {
				const table = node.parent.source ? tableName(nameOf(node.local)) : aliases.get(nameOf(node.local));
				if (table) report(node, table);
			},
			FunctionDeclaration: (node) => bindReturner(node.id, node),
			VariableDeclarator: (node) => {
				const init = unwrapped(node.init);
				if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression")
					bindReturner(node.id, init);
				if (node.id.type === "Identifier") bind(node.id, tableOf(init));
				if (node.id.type !== "ObjectPattern") return;
				for (const p of node.id.properties) {
					const key = p.type === "Property" ? keyName(p.key, p.computed) : null;
					if (tableName(key)) bind(p.value.type === "AssignmentPattern" ? p.value.left : p.value, tableName(key));
				}
			},
			CallExpression: (node) => {
				if (memberName(unwrapped(node.callee)) === "insert") pending.push([node.arguments[0], node]);
			},
			"Program:exit"() {
				for (const [target, at] of pending) {
					const table = tableOf(target);
					if (table) report(at, table);
				}
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
const TEXT_MATCH = new Set(["includes", "startsWith", "endsWith", "test", "match", "exec", "search"]);

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

const unwrapped = (node) => {
	let at = node;
	while (
		at &&
		[
			"TSAsExpression",
			"TSSatisfiesExpression",
			"TSNonNullExpression",
			"TSTypeAssertion",
			"ParenthesizedExpression",
			"ChainExpression",
		].includes(at.type)
	)
		at = at.expression;
	return at;
};
function emptyAnswer(node) {
	const at = unwrapped(node);
	if (!at) return null;
	if (at.type === "ArrayExpression" && at.elements.length === 0) return "an empty list";
	if ((at.type === "NewExpression" || at.type === "CallExpression") && at.callee.type === "Identifier") {
		if (at.callee.name === "Array" && at.arguments.length === 0) return "an empty list";
	}
	if (at.type === "Literal" && at.value === 0) return "a zero";
	if (at.type === "ConditionalExpression") return emptyAnswer(at.consequent) ?? emptyAnswer(at.alternate);
	if (at.type === "LogicalExpression") return emptyAnswer(at.right);
	if (at.type === "ObjectExpression") {
		const props = at.properties.filter((p) => p.type === "Property");
		if (props.some((p) => keyName(p.key, p.computed) === "status" && literalArgument(p.value) === "ok"))
			return "an ok result";
		for (const p of props) {
			const inner = emptyAnswer(p.value);
			if (inner) return inner;
		}
	}
	return null;
}

const readsMember = (node, name) => {
	const at = unwrapped(node);
	if (!at || typeof at !== "object") return false;
	if (
		at.type === "MemberExpression" &&
		unwrapped(at.object)?.type === "Identifier" &&
		unwrapped(at.object).name === name
	)
		return true;
	if (at.type === "BinaryExpression" && at.operator === "instanceof" && unwrapped(at.left)?.name === name) return true;
	return Object.entries(at).some(
		([key, value]) =>
			key !== "parent" &&
			(Array.isArray(value) ? value : [value]).some(
				(child) => child && typeof child.type === "string" && !FUNCTIONS.has(child.type) && readsMember(child, name),
			),
	);
};

const failureNotEmpty = {
	meta: { type: "problem" },
	create(context) {
		const report = (node, what) =>
			context.report({
				node,
				message: `A failed read never shows as ${what}: return the failure (lost, refused or unavailable), or narrow the catch with an if on the caught error (its code or class) for the one error that means nothing is there.`,
			});
		const check = (node, value) => {
			const what = emptyAnswer(value);
			if (what) report(node, what);
		};
		const walk = (node, caught) => {
			if (!node || typeof node.type !== "string" || FUNCTIONS.has(node.type)) return;
			if (node.type === "IfStatement" && caught && readsMember(node.test, caught)) return;
			if (node.type === "ReturnStatement") check(node, node.argument);
			if (node.type === "AssignmentExpression") check(node, node.right);
			if (node.type === "VariableDeclarator") check(node, node.init);
			for (const [key, value] of Object.entries(node))
				if (key !== "parent") for (const child of Array.isArray(value) ? value : [value]) walk(child, caught);
		};
		const handler = (fn) => {
			if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return;
			const caught = fn.params[0]?.type === "Identifier" ? fn.params[0].name : null;
			if (fn.body.type === "BlockStatement") for (const statement of fn.body.body) walk(statement, caught);
			else check(fn, fn.body);
		};
		return {
			CatchClause: (node) => {
				const caught = node.param?.type === "Identifier" ? node.param.name : null;
				for (const statement of node.body.body) walk(statement, caught);
			},
			CallExpression: (node) => {
				const callee = node.callee;
				if (callee.type !== "MemberExpression") return;
				const name = keyName(callee.property, callee.computed);
				if (name === "catch") handler(node.arguments[0]);
				if (name === "then") handler(node.arguments[1]);
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

const PROVIDER_KEY_MINTS = new Set([
	"packages/domain/src/communication/delivery.ts",
	"packages/domain/src/jobs/mail.ts",
]);
const PROVIDER_KEY = "ProviderKey";
const PROVIDER_KEY_HOME = "packages/contracts/src/common/values.ts";

const providerKeyMint = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (PROVIDER_KEY_MINTS.has(path) || path === PROVIDER_KEY_HOME || !PRODUCT_SOURCE.test(path)) return {};
		const message = `A ProviderKey is the key stored on its mail_request row: only ${[...PROVIDER_KEY_MINTS].join(" and ")} name the type, where they read or store that row, so a retry never reaches the provider with a fresh key.`;
		const named = (node) => node?.type === "Identifier" && node.name === PROVIDER_KEY;
		const report = (node) => context.report({ node, message });
		return {
			ImportSpecifier: (node) => named(node.imported) && report(node),
			ExportSpecifier: (node) => (named(node.local) || named(node.exported)) && report(node),
			TSQualifiedName: (node) => named(node.right) && report(node),
			TSImportType: (node) => (named(node.qualifier) || named(node.qualifier?.right)) && report(node),
		};
	},
};

const SITE_PATH = "SitePath";
const CASTS = new Set(["TSAsExpression", "TSTypeAssertion"]);
const typeName = (node) => {
	if (node.type === "TSTypeReference")
		return node.typeName.type === "Identifier" ? node.typeName.name : nameOf(node.typeName.right);
	return node.qualifier ? nameOf(node.qualifier.right ?? node.qualifier) : null;
};

const TEST_PATH = /(^|\/)tests?\/|\.test\./;

const noDoubleCast = {
	meta: { type: "problem" },
	create(context) {
		if (TEST_PATH.test(repoPath(context.filename))) return {};
		const inner = (node) => (node.type === "ParenthesizedExpression" ? inner(node.expression) : node);
		return {
			"TSAsExpression, TSTypeAssertion"(node) {
				const cast = inner(node.expression);
				if (CASTS.has(cast.type) && cast.typeAnnotation.type === "TSUnknownKeyword")
					context.report({
						node,
						message:
							"Do not cast through unknown: it switches the type checker off. Type the value at its source, or narrow it with a check.",
					});
			},
		};
	},
};

const sitePathCast = {
	meta: { type: "problem" },
	create(context) {
		const message = `Do not cast to ${SITE_PATH}: write the path as a literal or template that starts with "/" and a letter or digit, so the type proves it stays on this site. An untrusted return path goes through safeReturn.`;
		const names = new Set([SITE_PATH]);
		const aliases = new Map();
		const casts = [];
		return {
			ImportSpecifier(node) {
				if (nameOf(node.imported) === SITE_PATH) names.add(node.local.name);
			},
			"TSTypeReference, TSImportType"(node) {
				const name = typeName(node);
				if (!name) return;
				for (let at = node; at.parent; at = at.parent) {
					const parent = at.parent;
					if (CASTS.has(parent.type) && parent.typeAnnotation === at) return void casts.push({ node: parent, name });
					const named =
						(parent.type === "TSTypeAliasDeclaration" && parent.typeAnnotation === at) ||
						(parent.type === "TSTypeParameter" && parent.constraint === at)
							? nameOf(parent.id ?? parent.name)
							: null;
					if (named) return void aliases.set(named, [...(aliases.get(named) ?? []), name]);
					if (!parent.type.startsWith("TS")) return;
				}
			},
			"Program:exit"() {
				for (let size = 0; size !== names.size;) {
					size = names.size;
					for (const [alias, used] of aliases) if (used.some((name) => names.has(name))) names.add(alias);
				}
				for (const cast of casts) if (names.has(cast.name)) context.report({ node: cast.node, message });
			},
		};
	},
};

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

const PURE_IMPORTS = new Set(["@everyfield/db/deployment"]);

const pureModule = {
	meta: { type: "problem" },
	create(context) {
		const report = (node, what) =>
			context.report({
				node,
				message: `This module is a pure rule that reads only its arguments and does no I/O. Remove the ${what}.`,
			});
		return {
			ImportDeclaration: (node) =>
				typeOnly(node) ||
				PURE_IMPORTS.has(node.source.value) ||
				report(node, "value import (a type import or a pure module is fine)"),
			ImportExpression: (node) => report(node, "dynamic import"),
			AwaitExpression: (node) => report(node, "await"),
			ForOfStatement: (node) => node.await && report(node, "for await"),
			Identifier: (node) => IMPURE_GLOBALS.has(node.name) && isReference(node) && report(node, `use of ${node.name}`),
		};
	},
};

export const LOG_MODULE = "packages/domain/src/log.ts";
const LOGGED_CODE = /^(?:apps\/web\/src|packages\/(?:domain|evry)\/src)\//;

const CONSOLE_MODULES = new Set(["console", "node:console"]);
const CONSOLE_HOSTS = new Set(["globalThis", "global", "self", "window"]);
const PROCESS_STREAMS = new Set(["stdout", "stderr"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);

const serverLog = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === LOG_MODULE || !LOGGED_CODE.test(path)) return {};
		let client = false;
		const report = (node) =>
			client ||
			context.report({
				node,
				message: `Log through ${LOG_MODULE} (logLine, logInfo, logFailure): it writes fixed words, numbers, checked ids and an error's class and code, never error text or row values.`,
			});
		const global = (node, names) => node?.type === "Identifier" && names.has(node.name) && !declared(context, node);
		const processImports = new Set();
		const processObject = (node) =>
			global(node, new Set(["process"])) ||
			(node?.type === "Identifier" && processImports.has(node.name)) ||
			(memberName(node) === "process" && global(node.object, CONSOLE_HOSTS));
		return merge(
			moduleSources((node, name) => CONSOLE_MODULES.has(name) && report(node)),
			{
				Program(node) {
					client = node.body.some((s) => s.type === "ExpressionStatement" && s.directive === "use client");
				},
				Identifier(node) {
					if (node.name === "console" && isValueReference(node) && !declared(context, node)) report(node);
				},
				ImportDeclaration(node) {
					if (!PROCESS_MODULES.has(node.source.value)) return;
					for (const spec of node.specifiers)
						if (spec.type !== "ImportSpecifier") processImports.add(spec.local.name);
						else if (PROCESS_STREAMS.has(spec.imported.name ?? spec.imported.value)) report(spec);
				},
				VariableDeclarator(node) {
					if (node.id.type !== "ObjectPattern" || !processObject(node.init)) return;
					for (const p of node.id.properties)
						if (p.type === "Property" && PROCESS_STREAMS.has(keyName(p.key, p.computed))) report(p);
				},
				MemberExpression(node) {
					const name = memberName(node);
					if (name === "console" && global(node.object, CONSOLE_HOSTS)) report(node);
					if (PROCESS_STREAMS.has(name) && processObject(node.object)) report(node);
				},
			},
		);
	},
};

const ERROR_TEXT = new Set(["message", "stack"]);
const ERROR_EVENTS = new Set(["error", "uncaughtException", "unhandledRejection", "messageerror"]);
const ERROR_PARAM = /^(?:err|error|exception|[a-z]\w*Error)$/;
const SECRET_NAME =
	/(?:password|passphrase|secret|token|apikey|api_key|credential|cookie|authorization|payload|rawbody)$/i;
const TEXT_SINK_CLASS = /(?:Error|Refusal|Refused|Failure)$/;
const LOG_SINKS = new Set(["logLine", "logInfo", "logFailure", "asLogWord", "asLogId", "asLogHost", "asLogNames"]);
export const RAW_ERROR_SCOPE =
	/^(?:(?:apps\/web\/src|packages\/[^/]+\/src|ops|tools\/prod-identity)\/|tools\/qa\/(?!tests\/))/;
export const RAW_ERROR_SITES = {
	"packages/evry/src/adapters/native.ts": {
		sites: 2,
		why: "refusalOf passes on a message only when it is a code word ([a-z_]{3,40}); Evry's recorded refusals carry that word, so reading it another way would change recorded Evry results",
	},
	"packages/domain/src/documents/unpack.ts": {
		sites: 1,
		why: "ImportRejected is thrown only with fixed copy literals in documents/unpack.ts, and that copy is the answer the person importing the file reads",
	},
	"tools/qa/main.ts": {
		sites: 1,
		why: "only a QaError reaches the line, and a QaError is the tool's own copy from fail(), whose command output passed redactor.clean first",
	},
	"tools/qa/qa.ts": {
		sites: 1,
		why: "the cleanup line prints a QaError's own copy from fail(); any other error prints only its class name",
	},
	"tools/prod-identity/setup.ts": {
		sites: 2,
		why: "the operator's terminal line passes through redactor.clean, which holds every credential and generated key the tool read or made before it can fail",
	},
};

const TYPE_WRAPPERS = new Set([
	"TSAsExpression",
	"TSNonNullExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
	"ParenthesizedExpression",
]);
const outerOf = (node) => {
	let at = node;
	while (TYPE_WRAPPERS.has(at.parent?.type) && at.parent.expression === at) at = at.parent;
	return at;
};
const textOfError = (ref) => {
	let at = outerOf(ref);
	while (at.parent?.type === "MemberExpression" && at.parent.object === at) {
		const name = keyName(at.parent.property, at.parent.computed);
		if (ERROR_TEXT.has(name)) return at.parent;
		if (name !== "cause") return null;
		at = outerOf(at.parent);
	}
	const p = at.parent;
	if (!p) return null;
	if (p.type === "TemplateLiteral") return at;
	if (p.type === "BinaryExpression" && p.operator === "+") return at;
	if (p.type === "AssignmentExpression" && p.operator === "+=" && p.right === at) return at;
	if (p.type === "MemberExpression" && p.object === at && memberName(p) === "toString") return at;
	if (p.type === "VariableDeclarator" && p.init === at && p.id.type === "ObjectPattern")
		return p.id.properties.some((q) => q.type === "Property" && ERROR_TEXT.has(keyName(q.key, q.computed))) ? at : null;
	if ((p.type !== "CallExpression" && p.type !== "NewExpression") || !p.arguments.includes(at)) return null;
	const callee = p.callee;
	const name = callee.type === "Identifier" ? callee.name : memberName(callee);
	if (p.type === "NewExpression") return name && TEXT_SINK_CLASS.test(name) ? at : null;
	if (name === "String" || name === "Error" || name === "inspect") return at;
	if (name === "stringify" && callee.object?.type === "Identifier" && callee.object.name === "JSON") return at;
	return callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "console"
		? at
		: null;
};

const errorHandler = (node) => {
	const p = node.parent;
	if (p?.type !== "CallExpression" || !p.arguments.includes(node)) return false;
	const name = memberName(p.callee);
	const index = p.arguments.indexOf(node);
	if (name === "catch") return index === 0;
	if (name === "then") return index === 1;
	if (["on", "once", "addEventListener", "addListener", "prependListener"].includes(name ?? ""))
		return index === 1 && ERROR_EVENTS.has(literalArgument(p.arguments[0]) ?? "");
	return false;
};

const rawErrorText = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!RAW_ERROR_SCOPE.test(path)) return {};
		const allowed = RAW_ERROR_SITES[path];
		const found = [];
		const seen = new Set();
		const follow = (variable) => {
			if (!variable || seen.has(variable)) return;
			seen.add(variable);
			for (const reference of variable.references) {
				const ref = reference.identifier;
				if (!reference.isRead()) continue;
				const hit = textOfError(ref);
				if (hit) found.push({ node: hit, what: "a caught error's text" });
				const value = outerOf(ref);
				const p = value.parent;
				if (p?.type === "VariableDeclarator" && p.init === value && p.id.type === "Identifier")
					follow(context.sourceCode.getDeclaredVariables(p).find((v) => v.name === p.id.name));
			}
		};
		const fromParam = (owner, param) => {
			if (param?.type === "Identifier")
				follow(context.sourceCode.getDeclaredVariables(owner).find((v) => v.name === param.name));
			if (param?.type === "ObjectPattern")
				for (const q of param.properties)
					if (q.type === "Property" && ERROR_TEXT.has(keyName(q.key, q.computed)))
						found.push({ node: q, what: "a caught error's text" });
		};
		const secrets = (node, sink) => {
			if (!node || typeof node.type !== "string" || FUNCTIONS.has(node.type)) return;
			const name =
				node.type === "Identifier" && isValueReference(node)
					? node.name
					: node.type === "MemberExpression"
						? memberName(node)
						: null;
			if (name && SECRET_NAME.test(name)) {
				found.push({ node, what: `${name} in ${sink}` });
				return;
			}
			for (const [key, value] of Object.entries(node))
				if (key !== "parent" && !(node.type === "Property" && key === "key" && !node.computed))
					for (const child of Array.isArray(value) ? value : [value]) secrets(child, sink);
		};
		const sinkName = (callee) => (callee.type === "Identifier" ? callee.name : memberName(callee));
		const functionParams = (node) => {
			if (errorHandler(node)) return fromParam(node, node.params[0]);
			for (const param of node.params) {
				const id = param.type === "AssignmentPattern" ? param.left : param;
				if (id.type === "Identifier" && ERROR_PARAM.test(id.name)) fromParam(node, id);
			}
		};
		return {
			CatchClause(node) {
				fromParam(node, node.param);
			},
			ArrowFunctionExpression: functionParams,
			FunctionExpression: functionParams,
			FunctionDeclaration: functionParams,
			NewExpression(node) {
				const name = sinkName(node.callee);
				if (name && TEXT_SINK_CLASS.test(name)) for (const a of node.arguments) secrets(a, "error text");
			},
			CallExpression(node) {
				const name = sinkName(node.callee);
				if (name && (LOG_SINKS.has(name) || TEXT_SINK_CLASS.test(name)))
					for (const a of node.arguments)
						secrets(a, name.startsWith("as") || name.startsWith("log") ? "a log line" : "error text");
				if (
					node.callee.type === "MemberExpression" &&
					node.callee.object.type === "Identifier" &&
					node.callee.object.name === "console"
				)
					for (const a of node.arguments) secrets(a, "a log line");
			},
			ThrowStatement(node) {
				if (node.argument?.type === "TemplateLiteral" || node.argument?.type === "Literal")
					secrets(node.argument, "error text");
			},
			"Program:exit"(program) {
				const unique = [...new Map(found.map((f) => [`${f.node.range?.[0] ?? f.node.start}`, f])).values()];
				if (allowed) {
					if (unique.length !== allowed.sites)
						context.report({
							node: program,
							message: `${path} has ${unique.length} raw error or secret text sites; its RAW_ERROR_SITES entry allows exactly ${allowed.sites}. A new site is fixed, not allowed; when one goes, lower the entry.`,
						});
					return;
				}
				for (const { node, what } of unique)
					context.report({
						node,
						message: `Never put ${what} into a log, error text or stored record: it can carry SQL, row values, provider payloads or secrets. Log through @everyfield/domain/log (logFailure takes the error and keeps its class and code), throw a typed error with a fixed code, or keep the value out.`,
					});
			},
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
			: key.type === "TemplateLiteral" && key.expressions.length === 0
				? (key.quasis[0]?.value.cooked ?? null)
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

export const MINTS = new Map([
	[
		"issueRestrictedDeletionSession",
		["packages/domain/src/settings/deletion.ts", "packages/domain/src/settings/credentials.ts"],
	],
]);

const mintCallers = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!PRODUCT_CODE.test(path)) return {};
		const report = (node, name) => {
			const allowed = MINTS.get(name);
			if (!allowed || allowed.includes(path)) return;
			context.report({
				node,
				message: `Only ${allowed.join(" and ")} may name ${name}: it mints an authority, so no other module may reach it.`,
			});
		};
		return {
			Identifier: (node) =>
				(node.parent?.type !== "ExportSpecifier" || node.parent.local === node) && report(node, node.name),
			Literal: (node) => typeof node.value === "string" && report(node, node.value),
		};
	},
};

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

export const PRODUCT_TIMERS = {
	"apps/web/src/server/evry/http.ts": [
		{
			timer: "setInterval",
			binding: "heartbeat",
			within: "conversationStreamGet",
			delay: "15_000",
			why: "the Evry conversation stream writes an SSE comment every 15 seconds so proxies and the browser keep an idle stream open while a turn runs; the interval is the keep-alive itself and nothing else marks when a quiet connection needs one",
		},
	],
	"packages/evry/src/runtime/turn.ts": [
		{
			timer: "setTimeout",
			binding: "wall",
			within: "run",
			delay: "LIMITS.wallMs",
			why: "an Evry turn stops at its LIMITS.wallMs wall-time budget so a hung model or tool call cannot hold the run lease; the deadline is the limit itself and no event marks it",
		},
	],
	"packages/evry/src/runtime/model.ts": [
		{
			timer: "setTimeout",
			binding: "timer",
			within: "transientRetry",
			delay: "ms",
			why: "a transient model error is retried after the LIMITS.modelRetryDelaysMs backoff; the wait is the backoff itself and the turn's abort signal cancels it",
		},
	],
	"packages/evry/src/runtime/observe.ts": [
		{
			timer: "setTimeout",
			binding: "timer",
			within: "timerPause",
			delay: "ms",
			why: "a conversation observer re-reads the store every pollMs so it still sees events written by another instance; the pause is the poll interval and the abort signal ends it",
		},
	],
	"packages/db/src/schema/validate-file.ts": [
		{
			timer: "setTimeout",
			binding: "timer",
			within: "parser",
			delay: "STARTUP_MS",
			why: "a PDF parser worker that is not ready within STARTUP_MS counts as crashed, so a stuck worker cannot hold an upload; the deadline is the product limit",
		},
		{
			timer: "setTimeout",
			binding: "timer",
			within: "parseOnce",
			delay: "parseMs",
			why: "a PDF parse that runs past parseMs is refused and its worker stopped, so one file cannot hold the parser; the deadline is the product limit",
		},
	],
};

const functionBinding = (fn) => {
	if (fn.id?.name) return fn.id.name;
	let node = fn;
	while (node.parent?.type === "CallExpression" && node.parent.arguments.includes(node)) node = node.parent;
	return node.parent?.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
		? node.parent.id.name
		: null;
};

const declaredFunctions = (node) => {
	const found = [];
	for (let p = node.parent; p; p = p.parent) if (FUNCTIONS.has(p.type) && functionBinding(p)) found.push(p);
	return found;
};

const timerSite = (context, node, site) => {
	const call = node.parent;
	if (node.name !== site.timer || call?.type !== "CallExpression" || call.callee !== node) return false;
	const [nearest, ...outer] = declaredFunctions(call);
	return (
		call.parent?.type === "VariableDeclarator" &&
		call.parent.id.type === "Identifier" &&
		call.parent.id.name === site.binding &&
		context.sourceCode.getText(call.arguments[1]) === site.delay &&
		nearest !== undefined &&
		functionBinding(nearest) === site.within &&
		!outer.some((fn) => functionBinding(fn) === site.within)
	);
};

const noTimers = ratcheted("no-timers", (context, push) => {
	const seen = new Set();
	const sites = PRODUCT_TIMERS[repoPath(context.filename)] ?? [];
	const candidates = new Map(sites.map((site) => [site, []]));
	const hit = (node, name) =>
		push({
			node,
			fn: enclosingName(node),
			message: `${name} waits for time to pass instead of reacting to what the code waits for. Fix the ordering at its cause: act in the event handler, on the state change, on the promise or on the DOM node that is ready. A timer that is itself the product behavior (a countdown, a toast's lifetime, a poll, a typing debounce) needs an entry in ${survivorFile(context)} with its reason, which waits for the owner.`,
		});
	const report = (node, name) => {
		const at = (node.range ?? [node.start, node.end]).join(":");
		if (seen.has(at)) return;
		seen.add(at);
		const site = sites.find((s) => timerSite(context, node, s));
		if (site) candidates.get(site).push({ node, name });
		else hit(node, name);
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
		"Program:exit"(program) {
			for (const [site, found] of candidates) {
				if (found.length > 1)
					for (const c of found)
						push({
							node: c.node,
							fn: enclosingName(c.node),
							message: `${found.length} calls match the listed product timer ${site.timer} ${site.binding} in ${site.within} with delay ${site.delay}, which exempts exactly one. One of them is the listed product timer: keep it. Remove the copy that was added, or give a new timer its own binding and delay and its own reason.`,
						});
				if (!found.length)
					push({
						node: program,
						fn: null,
						message: `The listed product timer ${site.timer} ${site.binding} in ${site.within} with delay ${site.delay} is gone: delete its entry from PRODUCT_TIMERS in scripts/lint/everyfield-plugin.mjs.`,
					});
			}
		},
	};
	return merge(
		moduleUses(REACT_DOM, new Set(["flushSync"]), [], report),
		moduleUses(TIMER_MODULES, TIMERS, [], report),
		moduleUses(MOTION, MOTION_TIMERS, [], (node, name) => report(node, `${name} from motion`)),
		own,
	);
});

const DDL_RUNNERS = new Set(["packages/db/src/schema/migrate.ts", "packages/db/src/schema/drift.ts"]);
const ESCAPING_HELPERS = new Set(["literal", "finishStatement", "lockPrefix", "identifier"]);
const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">=", "in", "instanceof"]);

const constantType = (type) =>
	type?.type === "TSTypeQuery" || (type?.type === "TSIndexedAccessType" && constantType(type.objectType));

function literalOnly(type, aliases) {
	switch (type?.type) {
		case "TSLiteralType":
			return true;
		case "TSIndexedAccessType":
			return constantType(type);
		case "TSTypeOperator":
			return type.operator === "keyof" && type.typeAnnotation?.type === "TSTypeQuery";
		case "TSUnionType":
			return type.types.every((t) => literalOnly(t, aliases));
		case "TSIntersectionType":
			return type.types.some((t) => literalOnly(t, aliases));
		case "TSTypeReference": {
			const name = type.typeName.type === "Identifier" ? type.typeName.name : null;
			return name === "SqlLiteral" || (name !== null && aliases.has(name));
		}
		default:
			return false;
	}
}

function memberType(node, annotation) {
	const parent = node.parent;
	if (parent?.type !== "MemberExpression" || parent.object !== node || annotation?.type !== "TSTypeLiteral")
		return annotation;
	const name = memberName(parent);
	const member = annotation.members.find(
		(m) => m.type === "TSPropertySignature" && keyName(m.key, m.computed) === name,
	);
	return member?.typeAnnotation?.typeAnnotation;
}

const calleeName = (callee) => (callee.type === "Identifier" ? callee.name : memberName(callee));

const rawSqlLiteral = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!PRODUCT_CODE.test(path) || DDL_RUNNERS.has(path)) return {};
		const aliases = new Set();
		const sqlNames = new Set(["sql"]);
		const rawNames = new Set();
		let inside = 0;
		const isRawSql = (node) =>
			node.type === "CallExpression" &&
			((node.callee.type === "MemberExpression" &&
				node.callee.object.type === "Identifier" &&
				sqlNames.has(node.callee.object.name) &&
				memberName(node.callee) === "raw") ||
				(node.callee.type === "Identifier" && rawNames.has(node.callee.name)));
		const pasted = (node) => {
			for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
				if (isRawSql(parent)) return true;
				if (parent.type === "CallExpression" && parent.arguments.includes(child))
					if (ESCAPING_HELPERS.has(calleeName(parent.callee))) return false;
				if (parent.type === "ConditionalExpression" && parent.test === child) return false;
				if (parent.type === "BinaryExpression" && COMPARISONS.has(parent.operator)) return false;
				if (parent.type === "UnaryExpression" && parent.operator === "!") return false;
			}
			return false;
		};
		const variableOf = (node) => {
			for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
				const variable = scope.set?.get(node.name);
				if (variable) return { variable, scope };
			}
			return null;
		};
		const fixed = (node, seen = new Set()) => {
			switch (node?.type) {
				case "Literal":
					return true;
				case "TemplateLiteral":
					return node.expressions.every((e) => fixed(e, seen));
				case "ConditionalExpression":
					return fixed(node.consequent, seen) && fixed(node.alternate, seen);
				case "LogicalExpression":
				case "BinaryExpression":
					return fixed(node.left, seen) && fixed(node.right, seen);
				case "CallExpression":
					return ESCAPING_HELPERS.has(calleeName(node.callee));
				case "TSAsExpression":
				case "TSSatisfiesExpression":
				case "TSNonNullExpression":
					return fixed(node.expression, seen);
				case "MemberExpression":
					return fixed(node.object, seen) && (!node.computed || fixed(node.property, seen) || moduleLevel(node.object));
				case "ArrayExpression":
					return node.elements.every((e) => fixed(e, seen));
				case "Identifier":
					return safe(node, seen);
				default:
					return false;
			}
		};
		const moduleLevel = (node) => {
			const root = node.type === "MemberExpression" ? node.object : node;
			if (root.type === "MemberExpression") return moduleLevel(root);
			const found = root.type === "Identifier" ? variableOf(root) : null;
			return Boolean(found && (found.scope.type === "module" || found.scope.type === "global"));
		};
		const bound = (pattern, name, init) => {
			if (pattern === name) return init;
			if (pattern.type !== "ArrayPattern") return null;
			const index = pattern.elements.indexOf(name);
			const pick = (value) =>
				value?.type === "ArrayExpression"
					? value.elements[index]
					: value?.type === "ConditionalExpression"
						? { type: "ConditionalExpression", consequent: pick(value.consequent), alternate: pick(value.alternate) }
						: null;
			return index < 0 ? null : pick(init);
		};
		const safe = (node, seen = new Set()) => {
			const found = variableOf(node);
			if (!found) return true;
			const { variable, scope } = found;
			const def = variable.defs?.[0];
			if (!def || seen.has(def)) return true;
			seen.add(def);
			if (def.type === "ImportBinding" || def.type === "FunctionName" || def.type === "ClassName") return true;
			if (def.type === "Parameter") {
				const callback = def.node.parent?.type === "CallExpression" && def.node.parent.arguments.includes(def.node);
				const annotation = memberType(node, def.name.typeAnnotation?.typeAnnotation);
				if (!def.name.typeAnnotation && callback) return true;
				const generic = def.node.typeParameters?.params ?? [];
				const bound =
					annotation?.type === "TSTypeReference" &&
					annotation.typeName.type === "Identifier" &&
					generic.find((g) => g.name.name === annotation.typeName.name);
				return literalOnly(annotation, aliases) || Boolean(bound && literalOnly(bound.constraint, aliases));
			}
			if (def.type === "Variable") {
				if (scope.type === "module" || scope.type === "global") return true;
				if (literalOnly(def.name.typeAnnotation?.typeAnnotation, aliases)) return true;
				return def.parent?.kind === "const" && fixed(bound(def.node.id, def.name, def.node.init), seen);
			}
			return false;
		};
		return {
			ImportSpecifier(node) {
				if ((node.imported.name ?? node.imported.value) === "sql") sqlNames.add(node.local.name);
			},
			VariableDeclarator(node) {
				const init = node.init;
				if (node.id.type !== "Identifier" || init?.type !== "MemberExpression") return;
				if (init.object.type === "Identifier" && sqlNames.has(init.object.name) && memberName(init) === "raw")
					rawNames.add(node.id.name);
			},
			TSTypeAliasDeclaration(node) {
				if (node.parent?.type === "Program" || node.parent?.parent?.type === "Program")
					if (literalOnly(node.typeAnnotation, aliases)) aliases.add(node.id.name);
			},
			CallExpression(node) {
				if (isRawSql(node)) inside++;
			},
			"CallExpression:exit"(node) {
				if (isRawSql(node)) inside--;
			},
			Identifier(node) {
				if (inside === 0 || !isValueReference(node) || !pasted(node) || safe(node)) return;
				context.report({
					node,
					message:
						"A value pasted into sql.raw is a fixed SQL name: type a parameter as a literal union, keyof typeof a constant, or SqlLiteral<A> from @everyfield/db/query, build a local only from those, or escape it through literal, identifier, lockPrefix or finishStatement.",
				});
			},
		};
	},
};

export const STORAGE_MODULE = "packages/db/src/schema/storage.ts";
const OBJECT_STORE_PACKAGE = /^@aws-sdk(?:\/|$)/;
const URL_SIGNER_PACKAGE = /^@aws-sdk\/s3-request-presigner(?:\/|$)/;
const PRODUCT_CODE = /^(?:packages\/[^/]+\/src|apps\/web\/src)\//;

const storageClient = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === STORAGE_MODULE) return {};
		const product = PRODUCT_CODE.test(path);
		const message = `Only ${STORAGE_MODULE} reaches the object store and signs its URLs: the browser gets the app's own authenticated routes, never a storage key or a signed URL.`;
		return moduleSources((node, name) => {
			if (URL_SIGNER_PACKAGE.test(name) || (product && OBJECT_STORE_PACKAGE.test(name)))
				context.report({ node, message });
		});
	},
};

export const DEPLOYMENT_MODULE = "packages/db/src/deployment.ts";
const DEPLOYMENT_VARIABLES = new Set(["VERCEL", "VERCEL_ENV"]);

const deploymentEnv = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === DEPLOYMENT_MODULE || !PRODUCT_CODE.test(path)) return {};
		const report = (node) =>
			context.report({
				node,
				message: `Ask ${DEPLOYMENT_MODULE} where the code runs (isProduction, isTestDeployment, runsOffVercel, trustsVercelForwardedFor): it is the one reader of VERCEL and VERCEL_ENV, and an unrecognized value fails closed there.`,
			});
		const named = (key) => !key.computed && key.type === "Identifier" && DEPLOYMENT_VARIABLES.has(key.name);
		return {
			MemberExpression(node) {
				if (!node.computed && named(node.property)) report(node);
			},
			Property(node) {
				if (!node.computed && named(node.key)) report(node);
			},
			Literal(node) {
				if (DEPLOYMENT_VARIABLES.has(node.value)) report(node);
			},
			TemplateLiteral(node) {
				if (node.expressions.length === 0 && DEPLOYMENT_VARIABLES.has(node.quasis[0]?.value.cooked)) report(node);
			},
		};
	},
};

export const SERVER_CONFIG = "apps/web/src/server/config.ts";
const WEB_CODE = /^apps\/web\/src\//;
const ENV_PARSERS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

const isProcess = (node, context) =>
	(node?.type === "Identifier" && node.name === "process" && !declared(context, node)) ||
	(memberName(node) === "process" && isHost(node.object, context, GLOBAL_HOSTS));

const envMessage = `Read the server environment through ${SERVER_CONFIG}: serverConfig() for the values every deployment has (parsed once at start-up), serverEnv() for optional integrations.`;
const parseMessage = `Do not parse the whole server environment per call: add the value to ${SERVER_CONFIG}, which parses it once at start-up.`;
const isServerEnvCall = (node) =>
	node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "serverEnv";

const serverConfig = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === SERVER_CONFIG || !WEB_CODE.test(path)) return {};
		const copies = new Set();
		const pending = [];
		const wholeEnv = (node) =>
			isServerEnvCall(node) ||
			(node?.type === "Identifier" && copies.has(node.name)) ||
			(node?.type === "ObjectExpression" &&
				node.properties.some((p) => p.type === "SpreadElement" && wholeEnv(p.argument)));
		const bind = (id, init) => {
			if (id?.type === "Identifier" && isServerEnvCall(init)) copies.add(id.name);
		};
		return {
			ImportDeclaration(node) {
				if (
					PROCESS_MODULES.has(node.source.value) &&
					node.specifiers.some((spec) => spec.type !== "ImportSpecifier" || nameOf(spec.imported) === "env")
				)
					context.report({ node, message: envMessage });
			},
			ImportExpression(node) {
				if (PROCESS_MODULES.has(literalArgument(node.source) ?? "")) context.report({ node, message: envMessage });
			},
			Identifier(node) {
				if (node.name !== "process" || declared(context, node)) return;
				let target = node;
				const parent = node.parent;
				if (parent?.key === node && parent.value !== node && !parent.computed) return;
				if (parent?.type === "MemberExpression" && parent.property === node) {
					if (parent.computed || !isHost(parent.object, context, GLOBAL_HOSTS)) return;
					target = parent;
				}
				const use = target.parent;
				if (use?.type === "MemberExpression" && use.object === target) {
					const name = memberName(use);
					if (name !== null && name !== "env") return;
					if (name === "env" && use.parent?.type === "MemberExpression" && memberName(use.parent) === "NEXT_RUNTIME")
						return;
					context.report({ node: use, message: envMessage });
					return;
				}
				if (
					use?.type === "VariableDeclarator" &&
					use.init === target &&
					use.id.type === "ObjectPattern" &&
					use.id.properties.every((p) => p.type === "Property" && !p.computed && keyName(p.key, false) !== "env")
				)
					return;
				context.report({ node: target, message: envMessage });
			},
			CallExpression(node) {
				if (isRequire(node) && PROCESS_MODULES.has(literalArgument(node.arguments[0]) ?? ""))
					context.report({ node, message: envMessage });
				if (ENV_PARSERS.has(memberName(node.callee)) && node.arguments.length > 0) pending.push(node);
			},
			VariableDeclarator(node) {
				bind(node.id, node.init);
			},
			AssignmentPattern(node) {
				bind(node.left, node.right);
			},
			"Program:exit"() {
				for (const node of pending) if (wholeEnv(node.arguments[0])) context.report({ node, message: parseMessage });
			},
		};
	},
};

const SERVER_CODE = /^apps\/web\/src\/(?:server\/|app\/.*\/route\.tsx?$)/;
const LOG_CALLS = new Set(["logFailure", "logLine", "logInfo"]);

function walkOwn(node, visit) {
	if (!node || typeof node.type !== "string") return false;
	if (visit(node)) return true;
	for (const key of Object.keys(node)) {
		if (key === "parent") continue;
		const value = node[key];
		const children = Array.isArray(value) ? value : [value];
		for (const child of children) {
			if (!child || typeof child.type !== "string") continue;
			if (FUNCTIONS.has(child.type)) continue;
			if (walkOwn(child, visit)) return true;
		}
	}
	return false;
}

const TERMINAL = new Set(["ReturnStatement", "ThrowStatement"]);
const reachable = (node) => {
	const block = node.parent;
	if (block?.type !== "BlockStatement") return true;
	const at = block.body.indexOf(node);
	return !block.body.slice(0, at).some((s) => TERMINAL.has(s.type));
};
const isLostValue = (node) =>
	(node?.type === "Identifier" && node.name === "LOST") ||
	(node?.type === "ObjectExpression" &&
		node.properties.some(
			(p) =>
				p.type === "Property" &&
				keyName(p.key, p.computed) === "status" &&
				p.value.type === "Literal" &&
				p.value.value === "lost",
		));
const returned = (node) => {
	const parent = node.parent?.type === "AwaitExpression" ? node.parent.parent : node.parent;
	return (
		parent?.type === "ReturnStatement" ||
		(FUNCTIONS.has(parent?.type) && parent.body === (node.parent?.type === "AwaitExpression" ? node.parent : node))
	);
};

function handles(handler, body, param) {
	let thrown = false;
	let handed = false;
	let logged = false;
	let lost = handler && handler.body.type !== "BlockStatement" && isLostValue(handler.body);
	walkOwn(body, (node) => {
		if (node.type === "ThrowStatement" && reachable(node)) thrown = true;
		if (node.type === "ReturnStatement" && isLostValue(node.argument)) lost = true;
		if (node.type !== "CallExpression") return false;
		if (node.callee.type === "Identifier" && LOG_CALLS.has(node.callee.name)) logged = true;
		else if (param && node.arguments.some((a) => a.type === "Identifier" && a.name === param) && returned(node))
			handed = true;
		return false;
	});
	return thrown || handed || (logged && !lost);
}

const DATABASE_MODULES = /^(?:@everyfield\/db\/(?:query|tables|columns)|drizzle-orm(?:\/.*)?)$/;

const webDatabaseImports = {
	meta: { type: "problem" },
	create(context) {
		if (!WEB_CODE.test(repoPath(context.filename))) return {};
		return moduleSources((node, name) => {
			if (DATABASE_MODULES.test(name))
				context.report({
					node,
					message: `apps/web does not build SQL: ${name} belongs in @everyfield/domain. Call a domain operation, or move the statement into the domain module that owns its tables.`,
				});
		});
	},
};

const classTokens = (value) => value.split(/\s+/).filter(Boolean);
const MAGENTA_TINT = /^bg-magenta-(?:50|100)(?:\/\d+)?$/;
const AMBER_TINT = /^bg-(?:amber-(?:50|100)|\[var\(--ef-amber-(?:50|100)\)\]|\(--ef-amber-(?:50|100)\))(?:\/\d+)?$/;
const BOX_RADIUS = /^rounded(?:-[\w.[\]-]+)?$/;
const PILL_RADIUS = /^rounded(?:-[a-z]{1,2})?-(?:full|pill)$/;
const PADDING = /^p[xy]?-/;
const CHIP_SIZE = /^(?:p|py)-(?:0|px|0\.5|1|1\.5)$|^(?:h|size)-(?:\d+(?:\.\d+)?|px|\[[^\]]+\])$/;
const tintedBox = (tokens, tint) =>
	tokens.some((t) => tint.test(t)) &&
	tokens.some((t) => BOX_RADIUS.test(t)) &&
	!tokens.some((t) => PILL_RADIUS.test(t)) &&
	tokens.some((t) => PADDING.test(t)) &&
	!tokens.some((t) => CHIP_SIZE.test(t));
const errorNoticeLook = (value) => {
	const tokens = classTokens(value);
	return (tokens.includes("bg-magenta-50") && tokens.includes("text-magenta-600")) || tintedBox(tokens, MAGENTA_TINT);
};
const warningNoticeLook = (value) => tintedBox(classTokens(value), AMBER_TINT);
const noticeLook = (value) => errorNoticeLook(value) || warningNoticeLook(value);
const formGroup = (node) => {
	for (let at = node.parent; at && at.type !== "JSXElement"; at = at.parent)
		if (at.type === "JSXOpeningElement") return at.name.type === "JSXIdentifier" && at.name.name === "fieldset";
	return false;
};
const templateText = (node) => node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
const concatenated = (node) =>
	node.type === "BinaryExpression" && node.operator === "+"
		? [concatenatedOperand(node.left, node.right), concatenatedOperand(node.right, node.left)].reduce((a, b) =>
				a && b ? [...a, ...b] : null,
			)
		: node.type === "Literal" && typeof node.value === "string"
			? [node.value]
			: node.type === "TemplateLiteral"
				? [templateText(node)]
				: null;
const concatenatedOperand = (side, other) =>
	side.type === "Literal" && typeof side.value === "number"
		? concatenated(other) && [String(side.value)]
		: concatenated(side);
const classParts = (node) =>
	node.type === "Literal"
		? typeof node.value === "string"
			? [node.value]
			: []
		: node.type === "TemplateLiteral"
			? [templateText(node)]
			: node.type === "ConditionalExpression"
				? [...classParts(node.consequent), ...classParts(node.alternate)]
				: node.type === "LogicalExpression"
					? [...classParts(node.left), ...classParts(node.right)]
					: node.type === "ArrayExpression"
						? node.elements.flatMap((element) => (element ? classParts(element) : []))
						: node.type === "ObjectExpression"
							? node.properties.flatMap((property) => (property.type === "Property" ? classParts(property.key) : []))
							: node.type === "BinaryExpression"
								? [concatenated(node)?.join("")].filter(Boolean)
								: [];

const PROBLEM_TEXT = /^text-(?:magenta|red)-\d+(?:\/\d+)?$/;
const problemToken = (token) => PROBLEM_TEXT.test(token.replace(/^!|!$/g, "").split(":").at(-1));
const KEPT_PROBLEM_LINES = {
	"apps/web/src/features/tasks/TaskDialog.tsx": {
		className: "px-1 py-2 text-sm text-magenta-600",
		reason: "the relation search failure is a list result state, kept by T-407",
	},
	"apps/web/src/features/people/assessments/CommitmentDialogs.tsx": {
		className: "px-2 py-3 text-sm text-magenta-600",
		reason: "the people search failure is a list result state, kept by T-407",
	},
	"apps/web/src/features/meetings/dialogs.tsx": {
		className: "px-2 py-3 text-sm text-magenta-600",
		reason: "the people search failure is a list result state, kept by T-407",
	},
	"apps/web/src/features/evry/conversation/EvryPanel.tsx": {
		className: "flex max-w-[85%] flex-col items-end gap-2 text-right text-sm text-magenta-600",
		reason: "the message-level send state sits under its bubble, kept by T-407",
	},
};
const elementClassStrings = (opening) => {
	const className = jsxAttribute(opening, "className");
	return className ? attributeStrings(className) : [];
};
const problemClassed = (opening) => elementClassStrings(opening).some((s) => classTokens(s).some(problemToken));
const domDescendants = (node, out = []) => {
	for (const child of childNodes(node)) {
		if (child.type === "JSXOpeningElement" && domElement(child)) out.push(child);
		domDescendants(child, out);
	}
	return out;
};

const sharedNotice = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!WEB_CODE.test(path)) return {};
		const kept = KEPT_PROBLEM_LINES[path];
		let keptSeen = false;
		const keptLine = (node) => {
			if (!kept || keptSeen) return false;
			const strings = elementClassStrings(node);
			keptSeen = strings.length === 1 && strings[0] === kept.className;
			return keptSeen;
		};
		const check = (node, value) => {
			if (value === null) return;
			if (errorNoticeLook(value))
				context.report({
					node,
					message:
						"An error notice is Alert or InlineAlert from @everyfield/ui/controls (tone, title, actions, live region and focus included); a chip or band in that colour is TonePill, ToneTag or ToneBand from @everyfield/ui/display. Do not hand-write the magenta box.",
				});
			else if (warningNoticeLook(value) && !formGroup(node))
				context.report({
					node,
					message:
						'A warning notice is Alert or InlineAlert with tone="warning" from @everyfield/ui/controls (icon, title, actions, live region and focus included); a chip or band in amber is TonePill, ToneTag or ToneBand from @everyfield/ui/display. Do not hand-write the amber box.',
				});
		};
		return {
			JSXOpeningElement(node) {
				const role = domElement(node) && jsxAttribute(node, "role");
				if (!role || !attributeStrings(role).includes("alert")) return;
				if (!domDescendants(node.parent).some(problemClassed)) return;
				if (noticeLook(elementClassStrings(node).join(" ")) || keptLine(node)) return;
				context.report({
					node,
					message:
						'A problem line is ProblemText (a control-level line) or InlineAlert or Alert (a section-level line) from @everyfield/ui/controls, which carry the tone, icon and live region. Do not hand-write role="alert" with magenta or red text.',
				});
			},
			Literal: (node) => check(node, text(node)),
			TemplateLiteral: (node) => check(node, templateText(node)),
			BinaryExpression(node) {
				const parts = concatenated(node);
				if (!parts || parts.some(noticeLook) || (node.parent.type === "BinaryExpression" && concatenated(node.parent)))
					return;
				check(node, parts.join(""));
			},
			CallExpression(node) {
				const parts = node.arguments.flatMap(classParts);
				if (parts.length < 2 || parts.some(noticeLook)) return;
				check(node, parts.join(" "));
			},
		};
	},
};

const LIVE_REGION_CODE = /^(?:apps\/web|packages\/ui)\/src\//;
const LIVE_ROLES = new Set(["status", "alert", "log"]);
const jsxAttribute = (element, name) =>
	element.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
const attributeStrings = (attribute) =>
	attribute.value?.type === "JSXExpressionContainer"
		? stringsIn(attribute.value.expression)
		: stringsIn(attribute.value);
const HIDING_CLASSES = new Set(["hidden", "invisible"]);
const hidingToken = (token) => HIDING_CLASSES.has(token.replace(/^!|!$/g, "").split(":").at(-1));
const OFF_VALUES = { hidden: [false], inert: [false], "aria-hidden": [false, "false"] };
const attributeValue = (attribute) =>
	attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value;
const switchedOff = (attribute, name) => {
	const value = attributeValue(attribute);
	return (
		(value?.type === "Literal" && OFF_VALUES[name].includes(value.value)) ||
		(value?.type === "Identifier" && value.name === "undefined")
	);
};
const setAttribute = (element, name) => {
	const attribute = jsxAttribute(element, name);
	return attribute && !switchedOff(attribute, name) ? attribute : null;
};
const domElement = (element) => element.name.type === "JSXIdentifier" && /^[a-z]/.test(element.name.name);
const fixedStrings = (node) =>
	node?.type === "Literal" && typeof node.value === "string"
		? [node.value]
		: node?.type === "TemplateLiteral" && !node.expressions.length
			? [templateText(node)]
			: node?.type === "CallExpression"
				? node.arguments.flatMap((argument) => fixedStrings(argument))
				: [];
const unprefixedHidingToken = (token) => HIDING_CLASSES.has(token.replace(/^!|!$/g, ""));
const alwaysHidden = (element) => {
	const className = jsxAttribute(element, "className");
	return (
		(className && fixedStrings(attributeValue(className)).some((s) => classTokens(s).some(unprefixedHidingToken))) ||
		["hidden", "inert", "aria-hidden"].some((name) => {
			const attribute = setAttribute(element, name);
			return attribute && (!attribute.value || attributeValue(attribute).type === "Literal");
		})
	);
};
const portalElement = (element) =>
	/Portal$/.test(
		element.name.type === "JSXMemberExpression"
			? element.name.property.name
			: element.name.type === "JSXIdentifier"
				? element.name.name
				: "",
	);
const portalCall = (node) =>
	(node.callee.type === "Identifier" ? node.callee.name : memberName(node.callee)) === "createPortal";
const insideHiddenElement = (node) => {
	for (let child = node.parent, at = child.parent; at; child = at, at = at.parent) {
		if (at.type === "CallExpression" && portalCall(at)) return false;
		if (at.type !== "JSXElement" || child === at.openingElement) continue;
		if (portalElement(at.openingElement)) return false;
		if (domElement(at.openingElement) && alwaysHidden(at.openingElement)) return true;
	}
	return false;
};

const liveRegionInTree = {
	meta: { type: "problem" },
	create(context) {
		if (!LIVE_REGION_CODE.test(repoPath(context.filename))) return {};
		return {
			JSXOpeningElement(node) {
				const live = jsxAttribute(node, "aria-live");
				const role = jsxAttribute(node, "role");
				const liveValues = live ? attributeStrings(live) : [];
				const announces =
					(live && !(liveValues.length && liveValues.every((value) => value === "off"))) ||
					(role && attributeStrings(role).some((value) => LIVE_ROLES.has(value))) ||
					(!live && !role && node.name.type === "JSXIdentifier" && node.name.name === "output");
				if (!announces) return;
				const className = jsxAttribute(node, "className");
				const hiddenClass = className && attributeStrings(className).some((s) => s.split(/\s+/).some(hidingToken));
				const hiding =
					(hiddenClass && className) ||
					setAttribute(node, "hidden") ||
					setAttribute(node, "inert") ||
					setAttribute(node, "aria-hidden");
				if (!hiding) {
					if (insideHiddenElement(node))
						context.report({
							node,
							message:
								"This live region sits inside an element that is hidden, invisible, inert or aria-hidden, so it leaves the accessibility tree with it and what fills it is not announced. Keep the live region outside that element, or keep the element in the tree.",
						});
					return;
				}
				context.report({
					node: hiding,
					message:
						"A live region (aria-live, role status, alert or log, or an output element) that is hidden, invisible, inert or aria-hidden leaves the accessibility tree, so what fills it is not announced. Keep it in the tree: empty:sr-only while empty, or InlineAlert from @everyfield/ui/controls for a notice.",
				});
			},
		};
	},
};

const DOMAIN_JOBS = /^packages\/domain\/src\/jobs\//;
const noSilentCatch = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!(WEB_CODE.test(path) || DOMAIN_JOBS.test(path)) || path === "apps/web/src/server/platform/transient.ts")
			return {};
		let server = SERVER_CODE.test(path) || DOMAIN_JOBS.test(path);
		const message =
			"A server catch must rethrow, return the error handed to a handler, or log it through @everyfield/domain/log without answering lost: use transient() for a failure that may be retried, and catch only the error class you answer.";
		const pending = [];
		return {
			Program(node) {
				server ||= node.body.some(
					(s) =>
						(s.type === "ExpressionStatement" && s.directive === "use server") ||
						(s.type === "ImportDeclaration" && s.source.value === "server-only"),
				);
			},
			CatchClause(node) {
				const param = node.param?.type === "Identifier" ? node.param.name : null;
				if (!handles(null, node.body, param)) pending.push(node);
			},
			CallExpression(node) {
				const name = memberName(node.callee);
				const handler = name === "catch" ? node.arguments[0] : name === "then" ? node.arguments[1] : undefined;
				if (!handler) return;
				if (!FUNCTIONS.has(handler.type)) {
					if (handler.type === "Identifier" || handler.type === "MemberExpression") pending.push(node);
					return;
				}
				const param = handler.params[0]?.type === "Identifier" ? handler.params[0].name : null;
				if (!handles(handler, handler.body, param)) pending.push(node);
			},
			"Program:exit"() {
				if (server) for (const node of pending) context.report({ node, message });
			},
		};
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

const STORE_ACTIONS = "actions";
const readsOnlyActions = (call) => {
	const parent = call.parent;
	if (parent?.type === "MemberExpression" && parent.object === call) return memberName(parent) === STORE_ACTIONS;
	return (
		parent?.type === "VariableDeclarator" &&
		parent.init === call &&
		parent.id.type === "ObjectPattern" &&
		parent.id.properties.every((p) => p.type === "Property" && !p.computed && nameOf(p.key) === STORE_ACTIONS)
	);
};
const subscribedSnapshot = (node) => {
	const fn = callerOf(node);
	const call = fn?.parent;
	return (
		call?.type === "CallExpression" &&
		(call.callee.type === "Identifier" ? call.callee.name : memberName(call.callee)) === "useSyncExternalStore" &&
		call.arguments.indexOf(fn) > 0
	);
};

const bare = (node) => {
	let at = unwrapped(node);
	while (at?.type === "ChainExpression") at = unwrapped(at.expression);
	return at;
};
function variableOf(context, id) {
	for (let scope = context.sourceCode.getScope(id); scope; scope = scope.upper) {
		const variable = scope.set?.get(id.name);
		if (variable) return variable;
	}
	return null;
}

const noRenderGetState = {
	meta: { type: "problem" },
	create(context) {
		const jsx = /\.[jt]sx$/.test(context.filename);
		const bound = [];
		const calls = [];
		const aliases = new Set();
		const reads = (expression) => {
			const node = bare(expression);
			if (!node) return false;
			if (node.type === "Identifier") return aliases.has(variableOf(context, node));
			if (node.type === "CallExpression")
				return memberName(bare(node.callee)) === "bind" && reads(bare(node.callee).object);
			return memberName(node) === "getState";
		};
		const bind = (target, value) => {
			const id = target?.type === "AssignmentPattern" ? target.left : target;
			if (id?.type === "Identifier") bound.push({ id, value });
		};
		return {
			ObjectPattern(node) {
				for (const p of node.properties)
					if (p.type === "Property" && !p.computed && nameOf(p.key) === "getState") bind(p.value, null);
			},
			VariableDeclarator(node) {
				if (node.id.type === "Identifier" && node.init) bind(node.id, node.init);
			},
			AssignmentExpression(node) {
				if (node.operator === "=" && node.left.type === "Identifier") bind(node.left, node.right);
			},
			CallExpression(node) {
				calls.push(node);
			},
			"Program:exit"() {
				for (let grew = true; grew;) {
					grew = false;
					for (const { id, value } of bound) {
						const variable = variableOf(context, id);
						if (!variable || aliases.has(variable) || (value !== null && !reads(value))) continue;
						aliases.add(variable);
						grew = true;
					}
				}
				for (const node of calls) {
					const callee = bare(node.callee);
					const direct = !node.arguments.length && reads(callee);
					const through = ["call", "apply"].includes(memberName(callee)) && reads(callee.object);
					if (!direct && !through) continue;
					if (readsOnlyActions(node) || subscribedSnapshot(node) || !rendering(node, jsx)) continue;
					context.report({
						node,
						message:
							"getState() reads the store once while rendering and does not subscribe, so this render keeps showing the old value when the store changes. Select the value with useStore or the store context's useSelect, or read getState() inside the event handler or callback that needs it.",
					});
				}
			},
		};
	},
};

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

const READ_KEYS = new Map([
	["useRead", 1],
	["useReadWith", 1],
	["useLocalRead", 2],
]);
const READ_METHODS = new Set(["get", "peek", "prefetch", "seed", "refresh", "retry", "forget", "key"]);
const LINK_VALUE_SOURCES = new Set(["useOneTimeLinkValue", "currentOneTimeLinkValue"]);

function references(node, found, outsideFunctions = false) {
	if (!node || typeof node.type !== "string") return;
	if (outsideFunctions && FUNCTIONS.has(node.type)) return;
	if (node.type === "Identifier") found(node);
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) for (const item of value) references(item, found, outsideFunctions);
		else if (value && typeof value === "object") references(value, found, outsideFunctions);
	}
}

const linkValueKey = {
	meta: { type: "problem" },
	create(context) {
		const carried = new Set();
		const reads = new Set();
		const hooks = new Map(READ_KEYS);
		const carries = (node) => {
			let found = false;
			references(
				node,
				(id) => {
					if (LINK_VALUE_SOURCES.has(id.name) || carried.has(id.name)) found = true;
				},
				true,
			);
			return found;
		};
		const taint = (target, value) => {
			if (value && carries(value)) references(target, (id) => carried.add(id.name));
		};
		const report = (args) => {
			for (const arg of args)
				if (carries(arg))
					context.report({
						node: arg,
						message:
							"A one-time link value never keys a read: the key outlives the page in a module cache. Key the read by the record and let its loader take the value with currentOneTimeLinkValue inside the loader.",
					});
		};
		return {
			ImportSpecifier(node) {
				reads.add(node.local.name);
			},
			VariableDeclarator(node) {
				if (node.id.type === "Identifier" && node.init?.type === "Identifier" && hooks.has(node.init.name))
					hooks.set(node.id.name, hooks.get(node.init.name));
				if (
					node.id.type === "Identifier" &&
					node.init?.type === "CallExpression" &&
					node.init.callee.name === "createRead"
				)
					reads.add(node.id.name);
				taint(node.id, node.init);
			},
			AssignmentExpression(node) {
				taint(node.left, node.right);
			},
			CallExpression(node) {
				const callee = node.callee;
				if (callee.type === "Identifier" && hooks.has(callee.name))
					return report(node.arguments.slice(hooks.get(callee.name)));
				if (
					callee.type === "MemberExpression" &&
					callee.object.type === "Identifier" &&
					reads.has(callee.object.name) &&
					READ_METHODS.has(memberName(callee) ?? "")
				)
					report(node.arguments);
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

const jsxName = (name) =>
	name?.type === "JSXIdentifier" ? name.name : name?.type === "JSXMemberExpression" ? jsxName(name.property) : null;

const childNodes = (node) =>
	Object.entries(node)
		.filter(([key]) => key !== "parent" && key !== "loc" && key !== "range")
		.flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
		.filter((v) => v && typeof v.type === "string");

function stringsIn(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (node.type === "Literal" && typeof node.value === "string") out.push(node.value);
	else if (node.type === "TemplateElement") out.push(node.value.cooked ?? node.value.raw);
	for (const child of childNodes(node)) stringsIn(child, out);
	return out;
}

const classesOf = (element) => {
	const attr = element.openingElement.attributes.find(
		(a) => a.type === "JSXAttribute" && (a.name?.name === "className" || a.name?.name === "class"),
	);
	return attr ? stringsIn(attr.value).flatMap((s) => s.split(/\s+/).filter(Boolean)) : [];
};

const elementName = (element) => {
	const as = element.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "as");
	return as?.value?.type === "Literal" && typeof as.value.value === "string"
		? as.value.value
		: (jsxName(element.openingElement.name) ?? "");
};

const staticValue = (node) =>
	node?.type === "Literal"
		? node.value
		: node?.type === "TemplateLiteral" && node.expressions.length === 0
			? node.quasis[0].value.cooked
			: undefined;

function identifiersIn(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (node.type === "Identifier") out.push(node.name);
	if (node.type === "MemberExpression") {
		identifiersIn(node.object, out);
		if (!node.computed && node.property.type === "Identifier") out.push(`.${node.property.name}`);
		return out;
	}
	for (const child of childNodes(node)) identifiersIn(child, out);
	return out;
}

const timeContext = (call) => {
	for (let p = call.parent, child = call; p; child = p, p = p.parent) {
		if (p.type === "TemplateLiteral") {
			const i = p.expressions.indexOf(child);
			const before = p.quasis[i]?.value.cooked ?? "";
			const after = p.quasis[i + 1]?.value.cooked ?? "";
			return /[:\-T./]$/.test(before) || /^[:\-T./]/.test(after);
		}
		if (p.type === "VariableDeclarator") return p.id.type === "Identifier" && TIME_NAME.test(p.id.name);
		if (p.type === "ArrowFunctionExpression" || p.type === "FunctionExpression" || p.type === "FunctionDeclaration") {
			const name =
				p.type === "FunctionDeclaration"
					? p.id?.name
					: p.parent?.type === "VariableDeclarator"
						? p.parent.id.name
						: null;
			return Boolean(name && (TIME_NAME.test(name) || /^(?:p|pad|two)$/.test(name)));
		}
		if (p.type === "JSXExpressionContainer" || p.type === "ExpressionStatement") return false;
	}
	return false;
};

const insideFunction = (node, name) => {
	for (let p = node.parent; p; p = p.parent) {
		if (p.type === "FunctionDeclaration") return p.id?.name === name;
		if (p.type === "ArrowFunctionExpression" || p.type === "FunctionExpression")
			return p.parent?.type === "VariableDeclarator" && p.parent.id.name === name;
	}
	return false;
};

const noSlopStyling = ratcheted("no-slop-styling", (context, push) => {
	const path = repoPath(context.filename);
	if (!SCOPE.test(path)) return {};
	const marketing = isMarketing(path);
	const seen = new Set();
	const report = (node, kind, token, approvedFor) => {
		const key = `${node.range?.[0] ?? node.start}:${kind}:${token}`;
		if (seen.has(key)) return;
		seen.add(key);
		const message = approvedFor === "marketing" ? marketingMessage(kind, token) : slopMessage(kind, token);
		push({ node, fn: enclosingName(node), message });
	};
	const strings = (value, node) => {
		if (typeof value !== "string") return;
		for (const [kind, token, approvedFor] of classProblems(value, path)) report(node, kind, token, approvedFor);
	};
	const counterString = (node) =>
		node?.type === "Literal" && typeof node.value === "string" && COUNTER_TEXT.test(node.value);
	return {
		Literal: (node) => strings(node.value, node),
		TemplateElement: (node) => strings(node.value.cooked ?? node.value.raw, node),
		ObjectExpression(node) {
			const props = new Map();
			for (const p of node.properties) {
				if (p.type !== "Property" || p.computed) continue;
				const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
				const value = staticValue(p.value);
				if (value !== undefined) props.set(key, value);
				if (/^(?:n|num|number|step|index|label|counter|count)$/i.test(String(key)) && counterString(p.value))
					report(p.value, "counter", JSON.stringify(p.value.value));
			}
			for (const [kind, token] of styleProblems(props)) report(node, kind, token);
		},
		JSXText(node) {
			if (COUNTER_TEXT.test(node.value)) report(node, "counter", JSON.stringify(node.value.trim()));
		},
		JSXExpressionContainer(node) {
			if (counterString(node.expression) && node.parent?.type !== "JSXAttribute")
				report(node, "counter", JSON.stringify(node.expression.value));
		},
		ArrayExpression(node) {
			const counters = node.elements.filter(counterString);
			if (counters.length >= 2 && counters.length === node.elements.length)
				report(node, "counter", counters.map((c) => JSON.stringify(c.value)).join(", "));
		},
		CallExpression(node) {
			if (!marketing && node.callee.type === "Identifier" && node.callee.name === MARKETING_STEP.name)
				report(node, "counter", `${MARKETING_STEP.name}()`, "marketing");
			if (memberName(node.callee) !== "padStart") return;
			if (path === MARKETING_STEP.path && insideFunction(node, MARKETING_STEP.name)) return;
			const [width, fill] = node.arguments;
			if (staticValue(width) !== 2 || staticValue(fill) !== "0") return;
			const timeValue = identifiersIn(node.callee.object).some((n) => TIME_NAME.test(n.replace(/^\./, "")));
			if (!timeValue && !timeContext(node)) report(node, "counter", 'padStart(2, "0")');
		},
		JSXElement(node) {
			const kids = node.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
			for (let i = 0; i < kids.length - 1; i++) {
				const [label, next] = [kids[i], kids[i + 1]];
				if (label.type !== "JSXElement" || next.type !== "JSXElement") continue;
				if (headingLike(elementName(label), classesOf(label))) continue;
				if (!labelLike(classesOf(label))) continue;
				if (headingLike(elementName(next), classesOf(next)))
					report(label, "eyebrow", `<${jsxName(label.openingElement.name)}> label`);
			}
		},
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

const PRIVATE_IMPORTERS = {
	"apps/web/src/features/communication/outbox.ts": {
		importers: ["apps/web/src/features/communication/outbox-route.ts"],
		why: "it reads the dev outbox folder, so the send path stays free of directory reads and the production bundle does not trace the filesystem",
	},
	"apps/web/src/features/communication/outbox-route.ts": {
		importers: ["apps/web/src/app/api/dev/outbox/route.ts"],
		why: "it serves the dev mail capture, and only the dev outbox route may expose it",
	},
};

const privateImporters = {
	meta: { type: "problem" },
	create(context) {
		const from = repoPath(context.filename);
		return moduleSources((node, spec) => {
			const { to } = resolveImport(from, spec);
			const rule = to && PRIVATE_IMPORTERS[to];
			if (rule && !rule.importers.includes(from))
				context.report({ node, message: `Only ${rule.importers.join(", ")} imports ${to}: ${rule.why}.` });
		});
	},
};

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

const READ_NAME =
	/^(?:load|read|get|list|find|search|suggest|preview|compare|reload|fetch|query|count|download|print|resolve)(?:[A-Z]|$)/;

const READ_HOME =
	"Next queues server actions one at a time, so a read here waits behind every save and a save behind every read. Serve it from the feature's read.ts with defineReads, mount that GET handler under app/, and call it through readsFrom in the feature's fetch.ts.";

const boundNames = (pattern) => {
	if (!pattern) return [];
	if (pattern.type === "Identifier") return [pattern];
	if (pattern.type === "ObjectPattern")
		return pattern.properties.flatMap((p) => boundNames(p.type === "RestElement" ? p.argument : p.value));
	if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(boundNames);
	if (pattern.type === "AssignmentPattern") return boundNames(pattern.left);
	if (pattern.type === "RestElement") return boundNames(pattern.argument);
	return [];
};

const declaresServer = (fn) =>
	fn.body?.type === "BlockStatement" && fn.body.body.some((s) => s.directive === "use server");

const SELECTION_INPUT =
	"its input carries the selected person ids (up to 500, about 19.5 KB), too large for a GET address, so it stays a server action";
export const SELECTION_READS = {
	"apps/web/src/features/communication/actions.ts": { resolveAudience: SELECTION_INPUT },
	"apps/web/src/features/teams/training/actions.ts": { previewRoster: SELECTION_INPUT },
};

const noReadActions = ratcheted("no-read-actions", (context, push) => {
	const moduleActions = SERVER_ACTIONS.test(context.sourceCode.text);
	const selection = SELECTION_READS[repoPath(context.filename)] ?? {};
	const seen = new Set();
	const report = (node, name, where = `a read exported from a "use server" module`) => {
		if (Object.hasOwn(selection, name)) seen.add(name);
		else push({ node, fn: name, message: `${name} is ${where}. ${READ_HOME}` });
	};
	const exported = (id) => {
		if (moduleActions && id && READ_NAME.test(id.name)) report(id, id.name);
	};
	const inline = (fn) => {
		if (!declaresServer(fn)) return;
		const name = functionName(fn);
		if (name && READ_NAME.test(name)) report(fn, name, `a read declared as an inline "use server" function`);
	};
	return {
		ExportNamedDeclaration(node) {
			if (!moduleActions || node.exportKind === "type") return;
			const d = node.declaration;
			if (d?.type === "FunctionDeclaration") exported(d.id);
			if (d?.type === "VariableDeclaration") for (const v of d.declarations) boundNames(v.id).forEach(exported);
			for (const spec of node.specifiers ?? []) {
				const name = [nameOf(spec.local), nameOf(spec.exported)].find((n) => READ_NAME.test(n));
				if (spec.exportKind !== "type" && name) report(spec, name);
			}
		},
		ExportDefaultDeclaration(node) {
			const d = node.declaration;
			if (d.type === "FunctionDeclaration" || d.type === "Identifier") exported(d.type === "Identifier" ? d : d.id);
		},
		ExportAllDeclaration(node) {
			if (!moduleActions || node.exportKind === "type") return;
			push({
				node,
				fn: "*",
				message: `export * from ${node.source.value} in a "use server" module exports functions this rule cannot see, reads included. Name each server action this module exports. ${READ_HOME}`,
			});
		},
		FunctionDeclaration: inline,
		FunctionExpression: inline,
		ArrowFunctionExpression: inline,
		"Program:exit"(node) {
			for (const name of Object.keys(selection))
				if (!seen.has(name))
					context.report({
						node,
						message: `${name} is no longer a read action here: delete its SELECTION_READS entry in scripts/lint/everyfield-plugin.mjs.`,
					});
		},
	};
});

const WIRE_KEYWORDS = new Set([
	"TSUnknownKeyword",
	"TSStringKeyword",
	"TSNumberKeyword",
	"TSBooleanKeyword",
	"TSNullKeyword",
	"TSUndefinedKeyword",
]);

const wireType = (type) =>
	WIRE_KEYWORDS.has(type.type) ||
	(type.type === "TSTypeReference" &&
		type.typeName.type === "Identifier" &&
		type.typeName.name === "FormData" &&
		!type.typeArguments) ||
	(type.type === "TSUnionType" && type.types.every(wireType));

const PRIMITIVE_DEFAULT = new Set(["string", "number", "boolean"]);

const wireParam = (param) => {
	if (param.type === "AssignmentPattern") {
		if (param.left.typeAnnotation) return wireParam(param.left);
		return param.right.type === "Literal" && PRIMITIVE_DEFAULT.has(typeof param.right.value);
	}
	if (param.type !== "Identifier" || !param.typeAnnotation) return false;
	return wireType(param.typeAnnotation.typeAnnotation);
};

const WIRE_HOME =
	"A server action is a public POST endpoint: whatever the type says, its arguments arrive as untrusted JSON. Type each parameter unknown, string, number, boolean or FormData, and parse it once at the boundary, in the domain operation it reaches.";

function serverActions(context, check, opaque = () => {}) {
	const moduleActions = SERVER_ACTIONS.test(context.sourceCode.text);
	const wrapped = (node) => {
		if (!node) return [];
		if (FUNCTIONS.has(node.type)) return [node];
		if (node.type === "CallExpression") return node.arguments.flatMap(wrapped);
		if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") return wrapped(node.expression);
		return [];
	};
	const locals = new Map();
	const exportedLocals = [];
	const inline = (node) => {
		if (declaresServer(node)) check(node, functionName(node) ?? "an inline server action");
	};
	const exportedValue = (init, name) => {
		for (const fn of wrapped(init)) if (!declaresServer(fn)) check(fn, name);
	};
	return {
		FunctionDeclaration(node) {
			if (node.id) locals.set(node.id.name, node);
			inline(node);
		},
		VariableDeclarator(node) {
			if (node.id.type === "Identifier" && node.init) locals.set(node.id.name, node.init);
		},
		FunctionExpression: inline,
		ArrowFunctionExpression: inline,
		ExportNamedDeclaration(node) {
			if (!moduleActions || node.exportKind === "type") return;
			if (node.source) {
				for (const spec of node.specifiers ?? [])
					if (spec.exportKind !== "type")
						opaque(
							spec,
							nameOf(spec.exported),
							`${nameOf(spec.exported)} is re-exported from ${node.source.value}, so this rule cannot see its parameters. Declare the server action in this module.`,
						);
				return;
			}
			const d = node.declaration;
			if (d?.type === "FunctionDeclaration" && !declaresServer(d)) check(d, d.id.name);
			if (d?.type === "VariableDeclaration")
				for (const v of d.declarations) if (v.id.type === "Identifier") exportedValue(v.init, v.id.name);
			for (const spec of node.specifiers ?? [])
				if (spec.exportKind !== "type") exportedLocals.push([nameOf(spec.local), nameOf(spec.exported)]);
		},
		ExportDefaultDeclaration(node) {
			if (!moduleActions) return;
			const d = node.declaration;
			if (d.type === "Identifier") exportedLocals.push([d.name, "default"]);
			else if (d.type === "FunctionDeclaration") {
				if (!declaresServer(d)) check(d, d.id?.name ?? "default");
			} else exportedValue(d, "default");
		},
		ExportAllDeclaration(node) {
			if (!moduleActions || node.exportKind === "type") return;
			opaque(
				node,
				"*",
				`export * from ${node.source.value} in a "use server" module exports actions this rule cannot see. Declare each server action in this module.`,
			);
		},
		"Program:exit"() {
			for (const [local, exported] of exportedLocals) {
				const value = locals.get(local);
				if (value?.type === "FunctionDeclaration") {
					if (!declaresServer(value)) check(value, exported);
				} else exportedValue(value, exported);
			}
		},
	};
}

const actionParamsUnknown = ratcheted("action-params-unknown", (context, push) =>
	serverActions(
		context,
		(fn, name) => {
			for (const param of fn.params)
				if (!wireParam(param))
					push({ node: param, fn: name, message: `${name} takes a typed parameter. ${WIRE_HOME}` });
		},
		(node, fn, message) => push({ node, fn, message: `${message} ${WIRE_HOME}` }),
	),
);

const IDENTITY_PARAM = /^(?:actor|account|session|workspace)(?:id)?$/i;

const paramKeys = (pattern) => {
	if (!pattern) return [];
	if (pattern.type === "Identifier") return [[pattern, pattern.name]];
	if (pattern.type === "AssignmentPattern") return paramKeys(pattern.left);
	if (pattern.type === "RestElement") return paramKeys(pattern.argument);
	if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(paramKeys);
	if (pattern.type === "TSParameterProperty") return paramKeys(pattern.parameter);
	if (pattern.type !== "ObjectPattern") return [];
	return pattern.properties.flatMap((p) =>
		p.type === "RestElement"
			? paramKeys(p.argument)
			: [[p, keyName(p.key, p.computed)], ...(p.shorthand ? [] : paramKeys(p.value))],
	);
};

const actionIdentityParams = {
	meta: { type: "problem" },
	create(context) {
		return serverActions(context, (fn, name) => {
			for (const param of fn.params)
				for (const [node, key] of paramKeys(param))
					if (key && IDENTITY_PARAM.test(key))
						context.report({
							node,
							message: `${name} takes ${key} from the caller. A server action is a public POST endpoint, so a caller can send any ${key} it likes. Resolve who is asking from the session on the server (getViewer, viewerActor, organizationSeat in @/server/request-context) and take only the subject of the write as input.`,
						});
		});
	},
};

export const PROOF_CONTRACTS = {
	"@everyfield/contracts/identity": [
		"acceptSeatInvitationRequest",
		"describeInvitationRequest",
		"recoverPasswordRequest",
		"registrationRequest",
		"respondResidentInvitationRequest",
		"resumeRegistrationRequest",
		"verifyEmailRequest",
	],
	"@everyfield/contracts/organizations": ["acceptInvitationRequest", "respondInvitationRequest"],
};

const PROOF_KEY = /proof/i;
const PROOF_HOME =
	"An invitation or account link proof is a bearer secret: a server action takes its arguments as public POST JSON that Next logs and replays, so a proof never passes through one. The proof page posts it in the body of its own route (/api/connections/invitation, the identity routes), and server code reads a proof it set itself from its cookie.";

const fromNoInput = (node) => {
	const call = unwrap(node);
	return call?.type === "CallExpression" && call.arguments.length === 0;
};

const actionProofs = {
	meta: { type: "problem" },
	create(context) {
		if (!SERVER_ACTIONS.test(context.sourceCode.text)) return {};
		const report = (node, what) => context.report({ node, message: `This "use server" module ${what}. ${PROOF_HOME}` });
		const contracts = new Map(Object.entries(PROOF_CONTRACTS).map(([source, names]) => [source, new Set(names)]));
		const sources = new Set(contracts.keys());
		const names = new Set([...contracts.values()].flatMap((set) => [...set]));
		const key = (node) => (node.type === "Property" ? keyName(node.key, node.computed) : null);
		const uses = (node, name) => report(node, `uses the proof-carrying contract ${name}`);
		return merge(moduleUses(sources, names, [], uses, true), {
			ImportDeclaration(node) {
				if (node.importKind === "type") return;
				for (const spec of node.specifiers)
					if (
						spec.type === "ImportSpecifier" &&
						spec.importKind !== "type" &&
						contracts.get(node.source.value)?.has(nameOf(spec.imported))
					)
						uses(spec, nameOf(spec.imported));
			},
			Property(node) {
				const name = key(node);
				if (!name || !PROOF_KEY.test(name)) return;
				if (node.parent.type === "ObjectPattern") return report(node, `takes a field named ${name}`);
				if (!fromNoInput(node.value)) report(node, `forwards a field named ${name} it did not read itself`);
			},
			MemberExpression(node) {
				const name = memberName(node);
				if (name && PROOF_KEY.test(name)) report(node, `reads a field named ${name}`);
			},
			Identifier(node) {
				const fn = node.parent;
				if (FUNCTIONS.has(fn?.type) && fn.params.includes(node) && PROOF_KEY.test(node.name))
					report(node, `takes a parameter named ${node.name}`);
			},
		});
	},
};

const TOKEN_ONLY = new Set([
	"apps/web/src/features/communication/unsubscribe.ts",
	"apps/web/src/features/communication/unsubscribeActions.ts",
	"apps/web/src/features/communication/unsubscribeRoute.tsx",
	"apps/web/src/features/communication/unsubscribeOneClick.ts",
]);
const SESSION_MODULES = [
	/^apps\/web\/src\/server\/(?:request-context|identity|sign-in)(?:\.[cm]?[jt]sx?|\/|$)/,
	/^apps\/web\/src\/features\/[^/]+\/mount(?:\.[cm]?[jt]sx?)?$/,
];
const SESSION_PACKAGES = /^(?:next\/headers|better-auth(?:\/.*)?|@everyfield\/domain\/(?:access|identity))$/;
const SESSION_NAME = /viewer|session|actor|seat/i;

const tokenAuthority = {
	meta: { type: "problem" },
	create(context) {
		const from = repoPath(context.filename);
		if (!TOKEN_ONLY.has(from)) return {};
		const report = (node, what) =>
			context.report({
				node,
				message: `${what} in an unsubscribe module. The token in the link is the only authority here: a person who opens it may be signed out or signed in as someone else, so nothing may read the session, the request headers or a viewer.`,
			});
		return {
			...moduleSources((node, spec) => {
				const to = resolveImport(from, spec).to ?? "";
				if (SESSION_PACKAGES.test(spec) || SESSION_MODULES.some((m) => m.test(to)))
					report(node, `${spec} is a session, request-context or viewer module, imported`);
			}),
			ImportSpecifier(node) {
				if (SESSION_NAME.test(nameOf(node.imported))) report(node, `${nameOf(node.imported)} is imported`);
			},
		};
	},
};

const KEY_MINTS = new Set(["newRequestKey", "randomUUID"]);
const keySlot = (node) =>
	(node.parent?.type === "Property" && node.parent.value === node && nameOf(node.parent.key) === "requestKey") ||
	(node.parent?.type === "VariableDeclarator" &&
		node.parent.id.type === "Identifier" &&
		/requestKey/i.test(node.parent.id.name));
const insidePreview = (node) => {
	for (let at = node.parent; at; at = at.parent)
		if (at.type === "CallExpression" && /^preview/.test(calleeName(at.callee) ?? "")) return true;
	return false;
};
const clientRequestKey = {
	meta: { type: "problem" },
	create(context) {
		if (!SERVER_ACTIONS.test(context.sourceCode.text)) return {};
		return {
			CallExpression(node) {
				const name = calleeName(node.callee);
				if (!KEY_MINTS.has(name ?? "")) return;
				if (name === "randomUUID" && !keySlot(node)) return;
				if (insidePreview(node)) return;
				context.report({
					node,
					message: `A server action mints its own request key with ${name}(), so a retry of the same request reaches the server under a new key and runs again. Make the key in the client once per user intent and take it as a parameter. A preview that always rolls back may mint one.`,
				});
			},
		};
	},
};

export const OUTCOME_MODULE = "packages/contracts/src/common/values.ts";
const OUTCOME_SOURCE = "@everyfield/contracts/common";
const OUTCOME_SCOPE = /^(apps\/web\/src|packages\/[^/]+\/src)\//;
const statusLiterals = (type) =>
	type?.type === "TSLiteralType"
		? [keyName(type.literal, false)]
		: type?.type === "TSUnionType"
			? type.types.flatMap(statusLiterals)
			: [];
const propertiesOf = (member) =>
	member.type === "TSTypeLiteral" || member.type === "TSInterfaceBody"
		? (member.members ?? member.body).flatMap((m) =>
				m.type === "TSPropertySignature" ? [{ name: keyName(m.key, m.computed), type: m.typeAnnotation }] : [],
			)
		: member.type === "TSIntersectionType"
			? member.types.flatMap(propertiesOf)
			: [];
const memberStatuses = (member) =>
	propertiesOf(member)
		.filter((m) => m.name === "status")
		.flatMap((m) => statusLiterals(m.type?.typeAnnotation));
const referenceName = (type) =>
	type?.type === "TSTypeReference" && type.typeName.type === "Identifier" ? type.typeName.name : null;
const REPLY_SOURCE = /^@everyfield\/contracts\/[\w/-]+$/;
const sharedPiece = (source, name) =>
	source === OUTCOME_SOURCE && name === "Lost"
		? "lost"
		: (source === OUTCOME_SOURCE && name === "Reply") || /\wReply$/.test(name)
			? "reply"
			: null;
const OUTCOME_MESSAGE = `Import Outcome from ${OUTCOME_SOURCE} and specialize it (type Name<T> = Shared<T, Code, Extra>), so every feature answers the same union.`;
const sharedOutcome = ratcheted("shared-outcome", (context, push) => {
	const path = repoPath(context.filename);
	if (path === OUTCOME_MODULE || !OUTCOME_SCOPE.test(path)) return {};
	const shared = new Map();
	const imported = new Map();
	const namespaces = new Map();
	const aliases = new Map();
	const interfaces = new Map();
	const candidates = [];
	const interfaceParts = (name, seen) => {
		if (seen.has(name)) return [];
		seen.add(name);
		if (aliases.has(name)) return [aliases.get(name)];
		return (interfaces.get(name) ?? []).flatMap((block) => [
			block.body,
			...(block.extends ?? []).flatMap((h) =>
				h.expression.type === "Identifier" ? interfaceParts(h.expression.name, seen) : [],
			),
		]);
	};
	const members = (type, seen) => {
		if (type?.type === "TSUnionType") return type.types.flatMap((t) => members(t, seen));
		const name = referenceName(type);
		if (name && aliases.has(name) && !seen.has(name)) {
			seen.add(name);
			return members(aliases.get(name), seen);
		}
		if (name && interfaces.has(name)) return [{ type: "TSIntersectionType", types: interfaceParts(name, new Set()) }];
		return [type];
	};
	const pieceOf = (member) => {
		if (member?.type !== "TSTypeReference") return null;
		const { typeName } = member;
		if (typeName.type === "Identifier") return imported.get(typeName.name) ?? null;
		return typeName.type === "TSQualifiedName" &&
			typeName.left.type === "Identifier" &&
			namespaces.has(typeName.left.name)
			? sharedPiece(namespaces.get(typeName.left.name), typeName.right.name)
			: null;
	};
	const statusesOf = (member) =>
		({ lost: ["lost"], reply: ["ok", "refused"] })[pieceOf(member)] ?? memberStatuses(member);
	const okValue = (member) =>
		pieceOf(member) === "reply" ||
		(memberStatuses(member).includes("ok") && propertiesOf(member).some((m) => m.name === "value"));
	const shaped = (all) => {
		const statuses = new Set(all.flatMap(statusesOf));
		return all.some(okValue) && statuses.has("refused") && statuses.has("lost");
	};
	const outcomeShaped = (type) => {
		if (type?.type !== "TSUnionType") return false;
		const all = members(type, new Set());
		return shaped(all) && !shaped(all.filter(pieceOf));
	};
	const childTypes = (type) =>
		[
			...(type.types ?? []),
			...(type.elementTypes ?? []),
			...(type.typeArguments?.params ?? []),
			type.elementType,
			type.typeAnnotation,
		].filter(Boolean);
	const copyIn = (type) => (outcomeShaped(type) ? type : type && childTypes(type).map(copyIn).find(Boolean));
	const reportInline = (type) => {
		const copy = copyIn(type);
		if (copy)
			push({
				node: copy,
				fn: "inline",
				message: `This inline union copies the request boundary's ok / refused / lost reply shape. ${OUTCOME_MESSAGE}`,
			});
	};
	const inline = [];
	const typeOf = (node) => inline.push(node.typeAnnotation);
	return {
		ImportDeclaration(node) {
			const source = node.source.value;
			if (!REPLY_SOURCE.test(source)) return;
			for (const spec of node.specifiers)
				if (spec.type === "ImportNamespaceSpecifier") namespaces.set(spec.local.name, source);
				else if (spec.type === "ImportSpecifier") {
					const piece = sharedPiece(source, nameOf(spec.imported));
					if (piece) imported.set(spec.local.name, piece);
					if (source === OUTCOME_SOURCE) shared.set(spec.local.name, nameOf(spec.imported));
				}
		},
		TSTypeAliasDeclaration(node) {
			aliases.set(node.id.name, node.typeAnnotation);
			candidates.push(node);
		},
		TSInterfaceDeclaration(node) {
			interfaces.set(node.id.name, [...(interfaces.get(node.id.name) ?? []), node]);
		},
		TSTypeAnnotation: typeOf,
		TSAsExpression: typeOf,
		TSSatisfiesExpression: typeOf,
		TSTypeAssertion: typeOf,
		TSTypeParameter(node) {
			if (node.default) inline.push(node.default);
		},
		"Program:exit"() {
			inline.forEach(reportInline);
			for (const node of candidates) {
				const body = node.typeAnnotation;
				const copied =
					node.id.name === "Outcome" && node.typeParameters
						? shared.get(referenceName(body)) !== "Outcome"
						: copyIn(body);
				if (copied)
					push({
						node: node.id,
						fn: node.id.name,
						message: `${node.id.name} copies the request boundary's ok / refused / lost reply shape. ${OUTCOME_MESSAGE}`,
					});
			}
		},
	};
});

export const SIGN_IN_MODULE = "apps/web/src/server/sign-in.ts";
const REDIRECTS = ["redirect", "permanentRedirect"];
function leadingText(context, node, seen = new Set()) {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral") {
		let text = node.quasis[0].value.cooked;
		for (const [n, expression] of node.expressions.entries()) {
			const part = leadingText(context, expression, seen);
			if (part === null) return text;
			text += part + node.quasis[n + 1].value.cooked;
		}
		return text;
	}
	if (node?.type === "BinaryExpression" && node.operator === "+") {
		const left = leadingText(context, node.left, seen);
		if (left === null) return null;
		const right = leadingText(context, node.right, seen);
		return right === null ? left : left + right;
	}
	if (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression")
		return leadingText(context, node.expression, seen);
	if (node?.type !== "Identifier" || seen.has(node.name)) return null;
	seen.add(node.name);
	for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
		const def = scope.set?.get(node.name)?.defs?.[0];
		if (!def) continue;
		return def.node.type === "VariableDeclarator" && def.parent?.kind === "const"
			? leadingText(context, def.node.init, seen)
			: null;
	}
	return null;
}
const RETRY_ELIGIBILITY = new Set(["never", "refresh", "same_request", "reconcile"]);
const literalOutcomes = (node) => {
	const at = unwrapped(node);
	if (!at) return [];
	if (at.type === "ConditionalExpression") return [...literalOutcomes(at.consequent), ...literalOutcomes(at.alternate)];
	if (at.type === "LogicalExpression") return [...literalOutcomes(at.left), ...literalOutcomes(at.right)];
	const text = literalArgument(at);
	return text === null ? [] : [text];
};
const DEFINE_REFUSALS = "packages/domain/src/operations/refusals.ts";
const BARE_CODE =
	"defineRefusals adds details, correlationId and retry to a bare { code } refusal, which would change what Evry and the readers see";
export const REFUSAL_MECHANISMS = {
	"packages/domain/src/feedback/index.ts": { why: `Feedback refusals are a bare { code }: ${BARE_CODE}` },
	"packages/domain/src/dashboard/index.ts": { why: `Dashboard refusals are a bare { code }: ${BARE_CODE}` },
	"packages/domain/src/people/pipeline-metrics.ts": {
		why: "Pipeline metrics answers a bare { code } refusal that its contract test pins; defineRefusals adds details, correlationId and retry",
	},
	"packages/domain/src/settings/credentials.ts": {
		why: "Credential changes answer identity's credential outcome (a status with a correlationId and no retry)",
	},
	"packages/domain/src/organizations/seat.ts": {
		why: "Pipeline, program and import refusals are a { status, refusal } reply whose refusal carries a field or file problem beside its code",
	},
	"packages/domain/src/organizations/core.ts": {
		why: "Organization commands refuse with a typed code (OrganizationRefusal) that the web mount and Evry each turn into their own reply; organizations has no safe-error contract",
	},
	"packages/domain/src/people/csv/sheet.ts": {
		why: "SheetRefused carries a file problem that People CSV import and the organizations pipeline import each turn into their own refusal",
	},
};
const domainRefusals = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === DEFINE_REFUSALS) return {};
		const listed = Object.hasOwn(REFUSAL_MECHANISMS, path);
		let found = 0;
		const report = (node, what) => {
			found++;
			if (!listed)
				context.report({
					node,
					message: `${what} is hand-built. A domain module defines its refusals once with defineRefusals(errorSchema) from operations/refusals.ts and answers through its deny, refused and settle; retry comes from the contract.`,
				});
		};
		const refusalClass = (node) => {
			if (node.superClass && /Refus/.test(node.id?.name ?? "")) report(node, `The refusal class ${node.id.name}`);
		};
		return {
			ClassDeclaration: refusalClass,
			ClassExpression: refusalClass,
			Property(node) {
				if (node.parent?.type !== "ObjectExpression") return;
				const key = keyName(node.key, node.computed);
				if (key === "status" && literalOutcomes(node.value).includes("refused")) report(node, "A refusal reply");
				if (key === "retry" && literalOutcomes(node.value).some((v) => RETRY_ELIGIBILITY.has(v)))
					report(node, "A refusal's retry");
			},
			VariableDeclarator(node) {
				const init = unwrapped(node.init);
				if (node.id.type !== "Identifier" || !/retr(y|ies)/i.test(node.id.name)) return;
				if (init?.type === "ObjectExpression" || (init?.type === "NewExpression" && init.callee.name === "Map"))
					report(node, `The retry table ${node.id.name}`);
			},
			"Program:exit"(node) {
				if (listed && found === 0)
					context.report({
						node,
						message: `${path} no longer builds its own refusals: delete its REFUSAL_MECHANISMS entry in scripts/lint/everyfield-plugin.mjs.`,
					});
			},
		};
	},
};

export const ORGANIZATION_SEAT_CHECKS = {
	"packages/domain/src/access/organization-seat.ts":
		"organizationSeatContext is the one narrowing every domain and web gate shares",
};
const SEAT_CODE = /^(apps\/web\/src|packages\/domain\/src)\//;
const OWNER = { type: "Identifier", name: "owner" };
const ownerRead = (node) => {
	const at = unwrapped(node);
	if (at?.type === "ConditionalExpression") return ownerRead(at.consequent) || ownerRead(at.alternate);
	if (at?.type === "LogicalExpression") return ownerRead(at.left) || ownerRead(at.right);
	return at?.type === "MemberExpression" && memberName(at) === "owner";
};
const REBINDING = new Set(["=", "||=", "&&=", "??="]);
const seatNames = (context) => {
	const kinds = new Map();
	const owners = new Set();
	const variable = (id) => variableOf(context, id);
	const holds = (name, subject) => kinds.set(name, [...(kinds.get(name) ?? []), subject]);
	const bind = (pattern, from) => {
		if (pattern?.type !== "ObjectPattern") return;
		for (const property of pattern.properties) {
			if (property.type !== "Property") continue;
			const key = keyName(property.key, property.computed);
			const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value;
			if (key === "kind" && value.type === "Identifier") holds(variable(value), from);
			if (key === "owner" && value.type === "Identifier") owners.add(variable(value));
			if (key === "owner") bind(value, OWNER);
		}
	};
	const aliases = new Map();
	const rebound = (node) => {
		const at = unwrapped(node);
		if (at?.type === "ConditionalExpression") return [...rebound(at.consequent), ...rebound(at.alternate)];
		if (at?.type === "LogicalExpression") return [...rebound(at.left), ...rebound(at.right)];
		return at?.type === "Identifier" ? [at] : [];
	};
	const assign = (id, value) => {
		const init = unwrapped(value);
		if (id.type === "ObjectPattern") bind(id, init);
		if (id.type !== "Identifier") return;
		const name = variable(id);
		if (ownerRead(init)) owners.add(name);
		if (init?.type === "MemberExpression" && memberName(init) === "kind") holds(name, unwrapped(init.object));
		if (name) aliases.set(name, [...(aliases.get(name) ?? []), ...rebound(init)]);
	};
	const declare = (node) => assign(node.id, node.init);
	const reassign = (node) => {
		if (REBINDING.has(node.operator)) assign(node.left, node.right);
	};
	const kindOf = (node, seen = new Set()) => {
		const at = unwrapped(node);
		if (at?.type === "MemberExpression") return memberName(at) === "kind" ? [unwrapped(at.object)] : [];
		const name = at?.type === "Identifier" ? variable(at) : null;
		if (!name || seen.has(name)) return [];
		seen.add(name);
		return [...(kinds.get(name) ?? []), ...(aliases.get(name) ?? []).flatMap((target) => kindOf(target, seen))];
	};
	const namesOwner = (node, seen = new Set()) => {
		if (node?.type !== "Identifier") return memberName(node) === "owner";
		if (node.name === "owner") return true;
		const name = variable(node);
		if (!name || seen.has(name)) return false;
		seen.add(name);
		return owners.has(name) || (aliases.get(name) ?? []).some((target) => namesOwner(target, seen));
	};
	return { declare, reassign, kindOf, namesOwner };
};
const comparedKinds = (node, kindOf) => {
	if (node.type === "SwitchCase")
		return node.test ? kindOf(node.parent.discriminant).map((subject) => [subject, node.test]) : [];
	return [
		...kindOf(node.left).map((subject) => [subject, node.right]),
		...kindOf(node.right).map((subject) => [subject, node.left]),
	];
};

const organizationSeatCheck = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (!SEAT_CODE.test(path)) return {};
		const home = Object.hasOwn(ORGANIZATION_SEAT_CHECKS, path);
		const names = seatNames(context);
		const comparisons = [];
		const seats = [];
		const organizations = [];
		const visit = (node) => {
			if (node.type === "BinaryExpression" && !EQUALITY.has(node.operator)) return;
			comparisons.push(node);
		};
		const sort = (node) => {
			for (const [subject, value] of comparedKinds(node, names.kindOf)) {
				if (!subject || value?.type !== "Literal") continue;
				if (value.value === "seat") seats.push(nearestFunction(node));
				if (value.value === "organization" && names.namesOwner(subject) && !organizations.includes(node))
					organizations.push(node);
			}
		};
		const within = (fn, outer) => {
			for (let at = fn; at; at = nearestFunction(at)) if (at === outer) return true;
			return outer === null;
		};
		return {
			BinaryExpression: visit,
			SwitchCase: visit,
			VariableDeclarator: names.declare,
			AssignmentExpression: names.reassign,
			"Program:exit"(program) {
				comparisons.forEach(sort);
				const found = organizations.filter((node) => seats.some((fn) => within(nearestFunction(node), fn)));
				if (home && found.length === 0)
					context.report({
						node: program,
						message: `${path} no longer checks for an organization seat: delete its ORGANIZATION_SEAT_CHECKS entry in scripts/lint/everyfield-plugin.mjs.`,
					});
				if (home) return;
				for (const node of found)
					context.report({
						node,
						message: WEB_CODE.test(path)
							? "Read an organization seat with organizationSeat() or organizationSeatOf(actor) from @/server/request-context instead of checking the seat and its organization owner by hand."
							: "Read an organization seat with organizationSeatContext(authority) from packages/domain/src/access/organization-seat.ts instead of checking the seat and its organization owner by hand.",
					});
			},
		};
	},
};

export const LOOSE_CONTRACTS = {
	"packages/contracts/src/communication/requests.ts": {
		historyQuery:
			"it is the lenient history query: listHistory normalizes each value itself and drops a query key it does not name",
	},
};
const LOOSE_OBJECTS = new Set(["object", "looseObject"]);
const LOOSE_METHODS = new Set(["strip", "passthrough", "loose", "catchall"]);
const declaredName = (node) => {
	let named = null;
	for (let at = node; at; at = at.parent)
		if (at.type === "VariableDeclarator" && at.id.type === "Identifier") named = at.id.name;
	return named;
};

const strictContracts = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		const exempt = LOOSE_CONTRACTS[path] ?? {};
		const namespaces = new Set();
		const loose = new Set();
		const found = new Set();
		const refuse = (node) => {
			const name = declaredName(node);
			if (name && Object.hasOwn(exempt, name)) found.add(name);
			else
				context.report({
					node,
					message:
						"An object schema in packages/contracts or packages/evry is a z.strictObject with no strip, passthrough, loose or catchall, so a value with a key it does not name is refused instead of silently dropped. A schema that must drop keys is listed with its reason in LOOSE_CONTRACTS in scripts/lint/everyfield-plugin.mjs.",
				});
		};
		return {
			ImportDeclaration(node) {
				if (!/^zod(?:\/|$)/.test(node.source.value)) return;
				for (const spec of node.specifiers) {
					const imported = spec.type === "ImportSpecifier" ? nameOf(spec.imported) : null;
					if (spec.type !== "ImportSpecifier" || imported === "z") namespaces.add(spec.local.name);
					else if (LOOSE_OBJECTS.has(imported)) loose.add(spec.local.name);
				}
			},
			ExportAllDeclaration(node) {
				if (/^zod(?:\/|$)/.test(node.source.value)) refuse(node);
			},
			ExportNamedDeclaration(node) {
				if (!/^zod(?:\/|$)/.test(node.source?.value ?? "")) return;
				for (const spec of node.specifiers) if (LOOSE_OBJECTS.has(nameOf(spec.local))) refuse(spec);
			},
			VariableDeclarator(node) {
				const init = unwrapped(node.init);
				if (init?.type !== "Identifier" || !namespaces.has(init.name)) return;
				if (node.id.type === "Identifier") namespaces.add(node.id.name);
				if (node.id.type !== "ObjectPattern") return;
				for (const property of node.id.properties)
					if (property.type === "Property" && LOOSE_OBJECTS.has(keyName(property.key, property.computed)))
						refuse(property);
			},
			CallExpression(node) {
				const callee = unwrapped(node.callee);
				if (callee?.type === "Identifier" && loose.has(callee.name)) refuse(node);
			},
			MemberExpression(node) {
				const name = memberName(node);
				const fromNamespace =
					node.object.type === "Identifier" && namespaces.has(node.object.name) && LOOSE_OBJECTS.has(name);
				if (fromNamespace || LOOSE_METHODS.has(name)) refuse(node);
			},
			"Program:exit"(program) {
				for (const name of Object.keys(exempt))
					if (!found.has(name))
						context.report({
							node: program,
							message: `${path} no longer builds ${name} from a loose object: delete its LOOSE_CONTRACTS entry in scripts/lint/everyfield-plugin.mjs.`,
						});
			},
		};
	},
};

const signInRedirect = {
	meta: { type: "problem" },
	create(context) {
		const path = repoPath(context.filename);
		if (path === SIGN_IN_MODULE || !WEB_CODE.test(path)) return {};
		const redirects = new Set();
		const namespaces = new Set();
		const isRedirect = (callee) =>
			(callee.type === "Identifier" && redirects.has(callee.name)) ||
			(callee.type === "MemberExpression" &&
				callee.object.type === "Identifier" &&
				namespaces.has(callee.object.name) &&
				REDIRECTS.includes(callee.computed ? literalArgument(callee.property) : callee.property.name));
		return {
			ImportDeclaration(node) {
				if (node.source.value !== "next/navigation") return;
				for (const spec of node.specifiers) {
					if (spec.type === "ImportSpecifier" && REDIRECTS.includes(nameOf(spec.imported)))
						redirects.add(spec.local.name);
					if (spec.type === "ImportNamespaceSpecifier" || spec.type === "ImportDefaultSpecifier")
						namespaces.add(spec.local.name);
				}
			},
			CallExpression(node) {
				if (!isRedirect(node.callee)) return;
				if (!(leadingText(context, node.arguments[0]) ?? "").startsWith("/signin?")) return;
				context.report({
					node,
					message: "Send a signed-out visitor to sign in with signIn(returnTo) from server/sign-in.",
				});
			},
		};
	},
};

const CONSTRUCTED = new Set([
	"ObjectExpression",
	"ArrayExpression",
	"ArrowFunctionExpression",
	"FunctionExpression",
	"NewExpression",
]);
const WRAPPERS = new Set([
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"TSTypeAssertion",
	"ParenthesizedExpression",
]);
const unwrapValue = (node) => {
	let at = node;
	while (at && WRAPPERS.has(at.type)) at = at.expression;
	return at;
};
const providerName = (name) =>
	(name.type === "JSXIdentifier" && name.name.endsWith("Context")) ||
	(name.type === "JSXMemberExpression" && name.property.name === "Provider");
const enclosingFunction = (node) => {
	for (let at = node.parent; at; at = at.parent) if (FUNCTIONS.has(at.type)) return at;
	return null;
};
const restNamed = (pattern, name) => {
	if (!pattern) return false;
	if (pattern.type === "RestElement") return pattern.argument.type === "Identifier" && pattern.argument.name === name;
	if (pattern.type === "ObjectPattern") return pattern.properties.some((p) => restNamed(p, name));
	if (pattern.type === "ArrayPattern") return pattern.elements.some((p) => restNamed(p, name));
	if (pattern.type === "AssignmentPattern") return restNamed(pattern.left, name);
	return false;
};
const declares = (pattern, name) => {
	if (!pattern) return false;
	if (pattern.type === "Identifier") return pattern.name === name;
	if (pattern.type === "RestElement") return declares(pattern.argument, name);
	if (pattern.type === "AssignmentPattern") return declares(pattern.left, name);
	if (pattern.type === "Property") return declares(pattern.value, name);
	if (pattern.type === "ObjectPattern") return pattern.properties.some((p) => declares(p, name));
	if (pattern.type === "ArrayPattern") return pattern.elements.some((p) => declares(p, name));
	if (pattern.type === "TSParameterProperty") return declares(pattern.parameter, name);
	return false;
};
function ownBinding(fn, name) {
	if (fn.params.some((param) => restNamed(param, name))) return { rest: true };
	if (fn.params.some((param) => declares(param, name))) return { param: true };
	let found = null;
	walkOwn(fn.body, (node) => {
		if (node.type !== "VariableDeclarator") return false;
		if (node.id.type === "Identifier" && node.id.name === name) found = { init: node.init, fn };
		else if (restNamed(node.id, name)) found = { rest: true };
		else if (declares(node.id, name)) found = { param: true };
		return found !== null;
	});
	return found;
}
function bindingOf(fn, name) {
	for (let at = fn; at; at = enclosingFunction(at)) {
		const found = ownBinding(at, name);
		if (found) return found;
	}
	return null;
}
function builtInline(node, fn, seen = new Set()) {
	const value = unwrapValue(node);
	if (!value) return false;
	if (CONSTRUCTED.has(value.type)) return true;
	if (value.type === "ConditionalExpression")
		return builtInline(value.consequent, fn, seen) || builtInline(value.alternate, fn, seen);
	if (value.type === "LogicalExpression")
		return builtInline(value.left, fn, seen) || builtInline(value.right, fn, seen);
	if (value.type !== "Identifier" || seen.has(value.name)) return false;
	seen.add(value.name);
	const binding = bindingOf(fn, value.name);
	return binding?.rest === true || (binding?.init ? builtInline(binding.init, binding.fn, seen) : false);
}
const isCreateContext = (node) => {
	const call = unwrapValue(node);
	if (call?.type !== "CallExpression") return false;
	const callee = call.callee;
	return (
		(callee.type === "Identifier" && callee.name === "createContext") ||
		(callee.type === "MemberExpression" && !callee.computed && callee.property.name === "createContext")
	);
};

const contextNamed = (id) => id.type === "Identifier" && id.name.endsWith("Context");

const stableContextValue = {
	meta: { type: "problem" },
	create(context) {
		return {
			CallExpression(node) {
				if (!isCreateContext(node)) return;
				let at = node;
				while (WRAPPERS.has(at.parent?.type)) at = at.parent;
				const named =
					at.parent?.type === "VariableDeclarator" && at.parent.init === at ? contextNamed(at.parent.id) : false;
				if (named) return;
				context.report({
					node,
					message:
						"Bind a createContext result to a const named *Context, so the stable-value check sees every provider of it.",
				});
			},
			VariableDeclarator(node) {
				const init = unwrapValue(node.init);
				if (init?.type !== "Identifier" || !init.name.endsWith("Context") || contextNamed(node.id)) return;
				context.report({
					node: node.id,
					message: "Name an alias of a context *Context, so the stable-value check sees every provider of it.",
				});
			},
			JSXOpeningElement(node) {
				if (!providerName(node.name)) return;
				for (const attribute of node.attributes) {
					if (attribute.type !== "JSXAttribute" || attribute.name.name !== "value") continue;
					const expression = attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : null;
					if (!expression || !builtInline(expression, enclosingFunction(node))) continue;
					context.report({
						node: attribute,
						message:
							"A context value built during render is new on every render, so every consumer renders again. Build it with useMemo or useCallback, or keep it in a store, and pass the stable value.",
					});
				}
			},
		};
	},
};

const TEST_HOSTS = new Set(["test", "it", "default"]);

const CONFIRM_CODE = /^(?:apps\/web|packages\/ui)\/src\//;
const SETTLERS = new Set(["then", "catch", "finally"]);
const callOf = (node) => (node?.type === "ChainExpression" ? node.expression : node);
const isCall = (node) => callOf(node)?.type === "CallExpression";
const awaitedCall = (node) => node?.type === "AwaitExpression" && isCall(node.argument);
const voidedCall = (node) => node?.type === "UnaryExpression" && node.operator === "void" && isCall(node.argument);
const settledCall = (node) => isCall(node) && SETTLERS.has(memberName(callOf(node).callee));
const confirmKeepsRefusal = {
	meta: { type: "problem" },
	create(context) {
		if (!CONFIRM_CODE.test(repoPath(context.filename))) return {};
		const handlerOf = (node) => {
			if (FUNCTIONS.has(node?.type)) return node;
			if (node?.type !== "Identifier") return null;
			for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
				const def = scope.set?.get(node.name)?.defs?.[0];
				if (!def) continue;
				if (def.node.type === "FunctionDeclaration") return def.node;
				return def.node.type === "VariableDeclarator" &&
					def.parent?.kind === "const" &&
					FUNCTIONS.has(def.node.init?.type)
					? def.node.init
					: null;
			}
			return null;
		};
		const unread = (declarator) =>
			!context.sourceCode
				.getDeclaredVariables(declarator)
				.some((variable) => variable.references.some((reference) => reference.isRead()));
		const stateSetter = (callee) => {
			const def = context.sourceCode.getScope(callee).references.find((reference) => reference.identifier === callee)
				?.resolved?.defs[0];
			const declarator = def?.node;
			return (
				declarator?.type === "VariableDeclarator" &&
				declarator.id.type === "ArrayPattern" &&
				declarator.id.elements[1] === def.name &&
				declarator.init?.type === "CallExpression" &&
				calleeName(declarator.init.callee) === "useState"
			);
		};
		const dropping = (statements, found, floating) => {
			for (const statement of statements) {
				if (statement.type === "BlockStatement") {
					dropping(statement.body, found, floating);
					continue;
				}
				if (statement.type === "TryStatement") {
					dropping(statement.block.body, found, floating);
					dropping(statement.finalizer?.body ?? [], found, floating);
					continue;
				}
				if (statement.type === "VariableDeclaration") {
					if (statement.declarations.some((d) => awaitedCall(d.init) && unread(d))) found.push(statement);
					continue;
				}
				if (statement.type !== "ExpressionStatement") continue;
				const expression = statement.expression;
				if (awaitedCall(expression) || voidedCall(expression) || settledCall(expression)) found.push(statement);
				else if (isCall(expression) && !stateSetter(callOf(expression).callee)) floating.push(statement);
			}
		};
		const report = (node) =>
			context.report({
				node,
				message:
					"This onConfirm drops the answer of a call, so a refusal the call returns never reaches the dialog. Return it (return handler()), or turn its refusal into return { refused } here.",
			});
		return {
			JSXAttribute(node) {
				if (node.name.name !== "onConfirm" || node.value?.type !== "JSXExpressionContainer") return;
				const fn = handlerOf(node.value.expression);
				if (!fn) return;
				if (fn.body.type !== "BlockStatement") {
					if (voidedCall(fn.body)) report(fn.body);
					return;
				}
				if (walkOwn(fn.body, (n) => n.type === "ReturnStatement" && n.argument !== null)) return;
				const found = [];
				const floating = [];
				dropping(fn.body.body, found, floating);
				const awaits = walkOwn(fn.body, (n) => n.type === "AwaitExpression");
				if (fn.async && !awaits && floating.length) found.push(floating.at(-1));
				for (const statement of found) report(statement);
			},
		};
	},
};

const noDefaultDatabase = {
	meta: { type: "problem" },
	create(context) {
		return {
			AssignmentPattern(node) {
				if (!FUNCTIONS.has(node.parent?.type)) return;
				if (!walkOwn(node.right, (n) => n.type === "CallExpression" && calleeName(unwrapped(n.callee)) === "database"))
					return;
				context.report({
					node,
					message:
						"A default parameter that calls database() picks a pool the caller never sees. Make the database a required parameter and have each caller pass the one it uses.",
				});
			},
		};
	},
};

const oneTopLevelBefore = {
	meta: { type: "problem" },
	create(context) {
		const hooks = new Set();
		const hosts = new Set();
		const namespaces = new Set();
		const isHook = (callee) => {
			if (callee.type === "Identifier") return hooks.has(callee.name);
			if (callee.type !== "MemberExpression" || memberName(callee) !== "before") return false;
			const object = callee.object;
			if (object.type === "Identifier") return hosts.has(object.name) || namespaces.has(object.name);
			return (
				object.type === "MemberExpression" &&
				object.object.type === "Identifier" &&
				namespaces.has(object.object.name) &&
				TEST_HOSTS.has(memberName(object))
			);
		};
		return {
			ImportDeclaration(node) {
				if (node.source.value !== "node:test") return;
				for (const spec of node.specifiers) {
					if (spec.type === "ImportNamespaceSpecifier") namespaces.add(spec.local.name);
					else if (spec.type === "ImportDefaultSpecifier") hosts.add(spec.local.name);
					else if (nameOf(spec.imported) === "before") hooks.add(spec.local.name);
					else if (TEST_HOSTS.has(nameOf(spec.imported))) hosts.add(spec.local.name);
				}
			},
			VariableDeclarator(node) {
				const from = node.init;
				if (node.id.type !== "ObjectPattern" || from?.type !== "Identifier") return;
				const statement = node.parent.parent?.type === "ExportNamedDeclaration" ? node.parent.parent : node.parent;
				if (statement.parent?.type !== "Program") return;
				if (!hosts.has(from.name) && !namespaces.has(from.name)) return;
				for (const property of node.id.properties)
					if (
						property.type === "Property" &&
						property.value.type === "Identifier" &&
						keyName(property.key, property.computed) === "before"
					)
						hooks.add(property.value.name);
			},
			"Program:exit"(program) {
				const calls = program.body
					.filter((statement) => statement.type === "ExpressionStatement")
					.map((statement) =>
						statement.expression.type === "AwaitExpression" ? statement.expression.argument : statement.expression,
					)
					.filter((call) => call.type === "CallExpression" && isHook(call.callee));
				for (const call of calls.slice(1))
					context.report({
						node: call,
						message:
							"node:test starts a top-level before hook the moment it is registered, so a second one runs at the same time as the first. Put the file's setup in one before hook and await each step in order.",
					});
			},
		};
	},
};

const COUNT_TEXT_HOME = "packages/contracts/src/common/text.ts";
const COUNT_OPERATORS = new Set(["===", "!==", "==", "!=", ">", "<=", ">=", "<"]);
const IRREGULAR_PLURALS = new Map([
	["person", "people"],
	["child", "children"],
	["is", "are"],
	["has", "have"],
	["was", "were"],
	["it", "they"],
	["this", "these"],
	["does", "do"],
]);
const isOne = (node) => node?.type === "Literal" && node.value === 1;
const textOf = (node) => {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type !== "TemplateLiteral") return null;
	return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("\u0000");
};
const pluralOf = (one, many) => {
	const lower = one.toLowerCase();
	const other = many.toLowerCase();
	if (!/^[a-z-]+$/.test(lower) || lower === other) return false;
	return (
		other === `${lower}s` ||
		other === `${lower}es` ||
		(lower.endsWith("y") && other === `${lower.slice(0, -1)}ies`) ||
		IRREGULAR_PLURALS.get(lower) === other
	);
};
const words = (text) => text.split(/(\s+|[^\p{L}\p{N}\u0000-]+)/u).filter((part) => part !== "");
const countPair = (a, b) => {
	if ((a === "" && /^(?:e?s)$/.test(b)) || (b === "" && /^(?:e?s)$/.test(a))) return true;
	const left = words(a);
	const right = words(b);
	if (left.length !== right.length) return false;
	let plural = false;
	for (let index = 0; index < left.length; index += 1) {
		const x = left[index];
		const y = right[index];
		if (x === y) continue;
		if ((x === "1" && y === "\u0000") || (y === "1" && x === "\u0000")) continue;
		if (pluralOf(x, y) || pluralOf(y, x)) plural = true;
		else return false;
	}
	return plural;
};
const parameterOf = (identifier, context) => {
	if (identifier?.type !== "Identifier") return null;
	for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
		const def = scope.set?.get(identifier.name)?.defs?.[0];
		if (def) return def.type === "Parameter" ? def.node : null;
	}
	return null;
};
const countText = {
	meta: { type: "problem" },
	create(context) {
		if (repoPath(context.filename) === COUNT_TEXT_HOME) return {};
		return {
			ConditionalExpression(node) {
				const test = node.test;
				if (test.type !== "BinaryExpression" || !COUNT_OPERATORS.has(test.operator)) return;
				if (!isOne(test.left) && !isOne(test.right)) return;
				const a = textOf(node.consequent);
				const b = textOf(node.alternate);
				const owner = a === null || b === null ? parameterOf(node.consequent, context) : null;
				const handWritten =
					a !== null && b !== null ? countPair(a, b) : owner !== null && owner === parameterOf(node.alternate, context);
				if (!handWritten) return;
				context.report({
					node,
					message:
						'This writes count text by hand. Use counted(n, one, many) for "3 tasks" or countWord(n, one, many) for the word alone, from @everyfield/contracts/common.',
				});
			},
		};
	},
};

const CIVIL_DAY_HOME = "packages/contracts/src/common/day.ts";
const UTC_DAY = /T(?:12|00):00:00(?:\.000)?Z/;
const civilDay = {
	meta: { type: "problem" },
	create(context) {
		if (repoPath(context.filename) === CIVIL_DAY_HOME) return {};
		const report = (node) =>
			context.report({
				node,
				message:
					"This builds a midnight- or noon-UTC Date to handle a civil day. Use dayText(day, options), daysBetween(from, to), addDays(day, n) or weekdayOf(day) from @everyfield/contracts/common.",
			});
		return {
			Literal(node) {
				if (typeof node.value === "string" && UTC_DAY.test(node.value)) report(node);
			},
			TemplateLiteral(node) {
				if (node.quasis.some((quasi) => UTC_DAY.test(quasi.value.cooked ?? quasi.value.raw))) report(node);
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
		"raw-sql-literal": rawSqlLiteral,
		"request-actor": requestActor,
		"site-path-cast": sitePathCast,
		"no-double-cast": noDoubleCast,
		"provider-key-mint": providerKeyMint,
		"no-comments": noComments,
		"server-log": serverLog,
		"no-raw-error-log": rawErrorText,
		"clickable-host": clickableHost,
		"storage-client": storageClient,
		"deployment-env": deploymentEnv,
		"server-config": serverConfig,
		"no-silent-catch": noSilentCatch,
		"web-database-imports": webDatabaseImports,
		"shared-notice": sharedNotice,
		"no-cursor-utility": noCursorUtility,
		"no-slop-styling": noSlopStyling,
		"mint-callers": mintCallers,
		"no-raw-history": noRawHistory,
		"no-global-listeners": noGlobalListeners,
		"zustand-shape": zustandShape,
		"read-loader": readLoader,
		"link-value-key": linkValueKey,
		"no-render-writes": noRenderWrites,
		"no-render-get-state": noRenderGetState,
		"feature-boundaries": featureBoundaries,
		"private-importers": privateImporters,
		"no-sql-comments": noSqlComments,
		"no-error-message-match": noErrorMessageMatch,
		"route-reads": routeReads,
		"route-segment-defaults": routeSegmentDefaults,
		"render-reads": renderReads,
		"no-read-actions": noReadActions,
		"action-params-unknown": actionParamsUnknown,
		"action-identity-params": actionIdentityParams,
		"action-proofs": actionProofs,
		"token-authority": tokenAuthority,
		"client-request-key": clientRequestKey,
		"failure-not-empty": failureNotEmpty,
		"sign-in-redirect": signInRedirect,
		"organization-seat": organizationSeatCheck,
		"strict-contracts": strictContracts,
		"shared-outcome": sharedOutcome,
		"domain-refusals": domainRefusals,
		"stable-context-value": stableContextValue,
		"live-region-in-tree": liveRegionInTree,
		"one-top-level-before": oneTopLevelBefore,
		"confirm-keeps-refusal": confirmKeepsRefusal,
		"no-default-database": noDefaultDatabase,
		"count-text": countText,
		"civil-day": civilDay,
	},
};
