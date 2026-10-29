/**
 * Behaviour tests for the quota-error rewrite.
 *
 * Runs against the real `@earendil-works/pi-ai` classifier, which is what decides
 * whether Pi retries. Run with:
 *
 *   npm install && npm test
 */
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension resolves its config from the home directory at import time, so the
// sandbox has to exist before the module is loaded.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "pi-retry-enhance-"));
mkdirSync(join(SANDBOX_HOME, ".pi", "agent"), { recursive: true });
process.env.USERPROFILE = SANDBOX_HOME;
process.env.HOME = SANDBOX_HOME;

const CONFIG_PATH = join(SANDBOX_HOME, ".pi", "agent", "pi-retry-enhance.json");
writeFileSync(
	CONFIG_PATH,
	JSON.stringify({
		enabled: true,
		providers: [],
		patterns: [
			"insufficient_quota",
			"insufficient quota",
			"exceeded your current quota",
			"exceed your current quota",
			"quota has been exhausted",
			"quota exhausted",
			"quota exceeded",
			"out of budget",
			"insufficient credits",
			"more credits",
			"no credits",
			"credit balance",
			"insufficient balance",
			"add funds",
			"payment required",
			"usage limit",
			"billing",
		],
		retryablePrefix: "429 rate limit",
		maxDetailChars: 240,
		notify: false,
		logFile: "",
	}),
);

const extension = (await import("../index.ts")).default;

type Handler = (event: any, ctx?: any) => Promise<any>;
type CommandHandler = (args: string, ctx?: any) => Promise<void>;

interface Harness {
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: CommandHandler }>;
}

function load(): Harness & { notes: string[] } {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const notes: string[] = [];
	const ctx = {
		ui: {
			notify: (message: string) => notes.push(message),
			setStatus: () => {},
		},
	};
	const fakePi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
			return () => {};
		},
		registerCommand: (name: string, def: { handler: CommandHandler }) => {
			commands.set(name, def);
		},
		registerTool: () => {},
	};
	extension(fakePi as never);
	// Bind the shared ctx into every call site.
	for (const [name, handler] of handlers) handlers.set(name, (event) => handler(event, ctx));
	for (const [name, def] of commands) commands.set(name, { handler: (args) => def.handler(args, ctx) });
	return { handlers, commands, notes };
}

const assistantBase = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "openai",
	model: "gpt-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "error",
	timestamp: Date.now(),
};

const cases: Array<{ name: string; errorMessage: string; shouldRewrite: boolean }> = [
	{
		name: "OpenAI insufficient_quota (429)",
		errorMessage:
			'429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
		shouldRewrite: true,
	},
	{
		name: "OpenRouter out of credits (402)",
		errorMessage: '402: {"error":{"code":402,"message":"This request requires more credits, or fewer max_tokens."}}',
		shouldRewrite: true,
	},
	{
		name: "credit balance too low",
		errorMessage: "400: Your credit balance is too low to access the API.",
		shouldRewrite: true,
	},
	{
		name: "subscription usage limit",
		errorMessage: '429: {"type":"GoUsageLimitError","error":{"message":"Monthly usage limit reached"}}',
		shouldRewrite: true,
	},
	{
		name: "already retryable overload",
		errorMessage: "529 overloaded, please retry your request",
		shouldRewrite: false,
	},
	{
		name: "plain 500",
		errorMessage: "500: internal server error",
		shouldRewrite: false,
	},
	{
		name: "auth failure stays fatal",
		errorMessage: "401: Incorrect API key provided.",
		shouldRewrite: false,
	},
];

let failures = 0;
const check = (ok: boolean, label: string, detail: string): void => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} | ${label}\n       ${detail}`);
};

const { handlers, commands, notes } = load();
const messageEnd = handlers.get("message_end")!;

for (const testCase of cases) {
	const message = { ...assistantBase, errorMessage: testCase.errorMessage };
	const result = (await messageEnd({ type: "message_end", message })) as
		| { message?: { errorMessage?: string } }
		| undefined;
	const errorMessage = result?.message?.errorMessage ?? testCase.errorMessage;
	const rewrote = Boolean(result?.message) && errorMessage !== testCase.errorMessage;
	const retryable = isRetryableAssistantError({ ...message, errorMessage } as never);
	// AgentSession routes context overflow to compaction before it ever retries.
	const overflow = isContextOverflow({ ...message, errorMessage } as never, 200_000);

	check(
		rewrote === testCase.shouldRewrite && (!testCase.shouldRewrite || retryable) && !overflow,
		testCase.name,
		`rewritten=${rewrote} retryable=${retryable} overflow=${overflow} :: ${errorMessage.slice(0, 120)}`,
	);
}

// Reloading must not patch process-global state (v0.1 replaced globalThis.fetch).
const fetchBefore = globalThis.fetch;
load();
check(globalThis.fetch === fetchBefore, "no global fetch patching", "globalThis.fetch unchanged after reload");

// /retry-enhance test reports a retryable verdict.
await commands.get("retry-enhance")!.handler("on");
await commands.get("retry-enhance")!.handler("test");
check(
	(notes.at(-1) ?? "").includes("Pi would retry: true"),
	"/retry-enhance test reports retryable",
	notes.at(-1) ?? "",
);

// Disabled switch must be a hard no-op.
await commands.get("retry-enhance")!.handler("off");
const whileDisabled = (await messageEnd({
	type: "message_end",
	message: { ...assistantBase, errorMessage: "429: insufficient_quota" },
})) as { message?: unknown } | undefined;
check(!whileDisabled?.message, "disabled extension rewrites nothing", `notes: ${notes.at(-1) ?? ""}`);

rmSync(SANDBOX_HOME, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
