/**
 * pi-retry-enhance
 *
 * Makes Pi retry provider responses that Pi would otherwise treat as fatal
 * quota/billing errors (e.g. OpenAI's `insufficient_quota`).
 *
 * How it works
 * ------------
 * Pi classifies assistant failures by *text*, not by HTTP status:
 * `isRetryableAssistantError()` in `@earendil-works/pi-ai` matches the final
 * `errorMessage` against a non-retryable list first (which contains
 * `insufficient_quota`, `quota exceeded`, `billing`, ...) and only then against
 * the retryable list (`429`, `rate limit`, `overloaded`, ...). A message that
 * mentions `insufficient_quota` can therefore never be retried, no matter what
 * the HTTP layer returned.
 *
 * The one supported place to change that decision is the `message_end`
 * extension hook: a handler may return `{ message }`, and Pi replaces the
 * finalized assistant message in place *before* it runs its retry check. So this
 * extension detects quota/billing failures, rewrites `errorMessage` into a
 * message Pi's own classifier accepts (default prefix: `429 rate limit`), and
 * lets Pi's native retry loop (settings.retry) do the actual retrying.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "pi-retry-enhance.json");
const STATUS_KEY = "pi-retry-enhance";
const COMMAND_NAME = "retry-enhance";

interface RetryEnhanceConfig {
	/** Master switch. When false the extension does nothing. */
	enabled: boolean;
	/** Restrict to these Pi provider ids (e.g. "openai", "openrouter"). Empty = all providers. */
	providers: string[];
	/** Case-insensitive regexes (or plain substrings) that identify a quota/billing failure. */
	patterns: string[];
	/** Prefix used for the rewritten error message. Must read as retryable to Pi. */
	retryablePrefix: string;
	/** How much of the original error text to keep after neutralizing fatal keywords. */
	maxDetailChars: number;
	/** Show a one-time toast per failed run explaining that a retry was forced. */
	notify: boolean;
	/** Optional path to append a JSONL diagnostic log to. Empty = disabled. */
	logFile: string;
}

const DEFAULT_CONFIG: RetryEnhanceConfig = {
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
	notify: true,
	logFile: "",
};

/**
 * Keywords that make Pi's classifier refuse a retry. They must not survive in the
 * rewritten message. Keep in sync with NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
 * in @earendil-works/pi-ai (utils/retry.ts).
 */
const FATAL_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
	["subscription_sharing_workplace_individual_usage_limit_exceeded", "subscription-workspace-limit"],
	["subscription_sharing_usage_limit_exceeded", "subscription-usage-limit"],
	["GoUsageLimitError", "usage-limit-error"],
	["FreeUsageLimitError", "usage-limit-error"],
	["Monthly usage limit reached", "usage limit reached"],
	["available balance", "account balance"],
	["insufficient_quota", "quota-limit-code"],
	["out of budget", "out of allowance"],
	["quota exceeded", "quota reached"],
	["billing", "payment"],
];

/** Fallback used verbatim when even the neutralized text is rejected by Pi's classifier. */
const SAFE_MESSAGE = "429 rate limit";

type PiClassifier = (message: AssistantMessage) => boolean;

function getPiClassifier(): PiClassifier | undefined {
	// Namespace access (not a named import) so a Pi version without this export still loads.
	const candidate = (piAi as unknown as Record<string, unknown>).isRetryableAssistantError;
	return typeof candidate === "function" ? (candidate as PiClassifier) : undefined;
}

function matchesPattern(text: string, pattern: string): boolean {
	if (!pattern) return false;
	try {
		return new RegExp(pattern, "i").test(text);
	} catch {
		// Not a valid regex: fall back to a plain substring test.
		return text.toLowerCase().includes(pattern.toLowerCase());
	}
}

/** Strip keywords that would make Pi classify the rewritten message as fatal. */
function neutralizeFatalKeywords(text: string): string {
	let result = text;
	for (const [needle, replacement] of FATAL_KEYWORDS) {
		result = result.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replacement);
	}
	return result;
}

function buildRetryableMessage(original: string, config: RetryEnhanceConfig): string {
	const collapsed = neutralizeFatalKeywords(original)
		.replace(/\s+/g, " ")
		// Drop a leading "429: " so the prefix does not appear twice.
		.replace(/^\d{3}:\s*/, "")
		.trim();
	const truncated =
		collapsed.length > config.maxDetailChars ? `${collapsed.slice(0, config.maxDetailChars)}...` : collapsed;
	return truncated ? `${config.retryablePrefix}: ${truncated}` : config.retryablePrefix;
}

/** Verify the rewrite against Pi's own classifier when the running Pi exposes it. */
function acceptedByPi(errorMessage: string, template: AssistantMessage, classifier?: PiClassifier): boolean | undefined {
	if (!classifier) return undefined;
	try {
		return classifier({ ...template, errorMessage, stopReason: "error" });
	} catch {
		return undefined;
	}
}

function normalizeConfig(raw: unknown): RetryEnhanceConfig {
	const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const strings = (value: unknown, fallback: string[]): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
		providers: strings(source.providers, DEFAULT_CONFIG.providers),
		patterns: strings(source.patterns, DEFAULT_CONFIG.patterns),
		retryablePrefix:
			typeof source.retryablePrefix === "string" && source.retryablePrefix.trim()
				? source.retryablePrefix.trim()
				: DEFAULT_CONFIG.retryablePrefix,
		maxDetailChars:
			typeof source.maxDetailChars === "number" && Number.isFinite(source.maxDetailChars) && source.maxDetailChars >= 0
				? Math.floor(source.maxDetailChars)
				: DEFAULT_CONFIG.maxDetailChars,
		notify: typeof source.notify === "boolean" ? source.notify : DEFAULT_CONFIG.notify,
		logFile: typeof source.logFile === "string" ? source.logFile : DEFAULT_CONFIG.logFile,
	};
}

function writeConfig(config: RetryEnhanceConfig): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// A read-only home directory must not break the session.
	}
}

function loadConfig(): RetryEnhanceConfig {
	if (!existsSync(CONFIG_PATH)) {
		writeConfig(DEFAULT_CONFIG);
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		const normalized = normalizeConfig(raw);
		// v0.1 wrote a different shape (hosts / retryableStatusCodes / ...). Rewrite it once so
		// the user sees the options that actually exist.
		const legacy = typeof raw !== "object" || raw === null || !("patterns" in raw);
		if (legacy) writeConfig(normalized);
		return normalized;
	} catch {
		// Keep the broken file around for inspection, then start from defaults.
		try {
			writeFileSync(`${CONFIG_PATH}.bak`, readFileSync(CONFIG_PATH, "utf-8"), "utf-8");
		} catch {
			// ignore
		}
		writeConfig(DEFAULT_CONFIG);
		return { ...DEFAULT_CONFIG };
	}
}

function describe(config: RetryEnhanceConfig): string {
	const scope = config.providers.length > 0 ? config.providers.join(", ") : "all providers";
	return `${config.enabled ? "on" : "off"} | ${scope} | ${config.patterns.length} patterns | retries: Pi settings.retry`;
}

export default function piRetryEnhance(pi: ExtensionAPI) {
	const config = loadConfig();
	const state = { notifyArmed: true, rewrites: 0 };
	const classifier = getPiClassifier();

	const log = (entry: Record<string, unknown>): void => {
		if (!config.logFile) return;
		try {
			appendFileSync(config.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8");
		} catch {
			// Logging must never affect the run.
		}
	};

	const handleAssistantError = async (
		message: AssistantMessage,
		ctx: ExtensionContext,
	): Promise<AssistantMessage | undefined> => {
		if (!config.enabled) return undefined;
		if (message.stopReason !== "error" || !message.errorMessage) return undefined;
		if (config.providers.length > 0 && !config.providers.includes(message.provider)) return undefined;

		const original = message.errorMessage;

		// Already retryable: Pi handles it natively, nothing to do.
		const alreadyRetryable = acceptedByPi(original, message, classifier);
		if (alreadyRetryable === true) return undefined;

		const pattern = config.patterns.find((candidate) => matchesPattern(original, candidate));
		const knownFatalKeyword = FATAL_KEYWORDS.some(([needle]) => matchesPattern(original, needle));
		if (!pattern && !knownFatalKeyword) return undefined;

		let rewritten = buildRetryableMessage(original, config);

		// Safety net: if Pi's classifier still refuses the rewrite (for example because a
		// newer Pi added a keyword we do not know about), fall back to a bare message.
		if (acceptedByPi(rewritten, message, classifier) === false) {
			rewritten = SAFE_MESSAGE;
		}

		state.rewrites++;
		log({
			event: "rewrite",
			provider: message.provider,
			model: message.model,
			pattern: pattern ?? "(fatal keyword)",
			cause: original.slice(0, 500),
			rewritten,
			classifier: classifier ? "pi" : "unavailable",
		});

		if (config.notify && state.notifyArmed) {
			state.notifyArmed = false;
			ctx.ui.notify(
				`pi-retry-enhance: quota error treated as retryable (${pattern ?? "known quota keyword"}); Pi will retry.`,
				"warning",
			);
		}

		return { ...message, errorMessage: rewritten };
	};

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;

		const rewritten = await handleAssistantError(event.message, ctx);
		if (rewritten) return { message: rewritten };

		// A healthy assistant response re-arms the toast for the next failure.
		if (event.message.stopReason !== "error") state.notifyArmed = true;
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, config.enabled ? "quota-retry:on" : "quota-retry:off");
		if (config.enabled) {
			ctx.ui.notify(
				`pi-retry-enhance active — forcing retries for quota errors (${describe(config)}).`,
				"info",
			);
		} else {
			ctx.ui.notify("pi-retry-enhance loaded but disabled. Run /retry-enhance on to enable it.", "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect or change pi-retry-enhance settings (status | on | off | test)",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();

			if (action === "on" || action === "off") {
				config.enabled = action === "on";
				writeConfig(config);
				ctx.ui.setStatus(STATUS_KEY, config.enabled ? "quota-retry:on" : "quota-retry:off");
				ctx.ui.notify(`pi-retry-enhance: ${describe(config)}`, "info");
				return;
			}

			if (action === "test") {
				const sample: AssistantMessage = {
					role: "assistant",
					content: [],
					api: "openai-completions" as AssistantMessage["api"],
					provider: "openai",
					model: "gpt-test",
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
					errorMessage:
						'429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
				};
				const rewritten = await handleAssistantError(sample, ctx);
				if (!rewritten) {
					ctx.ui.notify(
						"pi-retry-enhance test: sample quota error was NOT rewritten. Check the pattern list and `enabled`.",
						"error",
					);
					return;
				}
				const verdict = acceptedByPi(rewritten.errorMessage ?? "", sample, classifier);
				ctx.ui.notify(
					`pi-retry-enhance test: "${rewritten.errorMessage}" → Pi would retry: ${verdict === undefined ? "unknown (classifier unavailable)" : verdict}`,
					"info",
				);
				return;
			}

			ctx.ui.notify(`pi-retry-enhance: ${describe(config)} | rewrites this session: ${state.rewrites}`, "info");
		},
	});
}
