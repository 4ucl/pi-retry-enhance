import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RetryEnhanceConfig {
  hosts?: string[];
  retryableStatusCodes?: number[];
  retryablePatterns?: string[];
  retryableCodes?: string[];
  maxBodyChars?: number;
}

const DEFAULT_CONFIG: Required<RetryEnhanceConfig> = {
  hosts: [],
  retryableStatusCodes: [429],
  retryablePatterns: ["insufficient_quota", "quota exceeded", "rate limit", "too many requests"],
  retryableCodes: ["insufficient_quota"],
  maxBodyChars: 4000,
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-retry-enhance.json");

function readConfig(): Required<RetryEnhanceConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      hosts: Array.isArray(raw?.hosts) ? raw.hosts : DEFAULT_CONFIG.hosts,
      retryableStatusCodes: Array.isArray(raw?.retryableStatusCodes)
        ? raw.retryableStatusCodes.map(Number)
        : DEFAULT_CONFIG.retryableStatusCodes,
      retryablePatterns: Array.isArray(raw?.retryablePatterns)
        ? raw.retryablePatterns
        : DEFAULT_CONFIG.retryablePatterns,
      retryableCodes: Array.isArray(raw?.retryableCodes)
        ? raw.retryableCodes
        : DEFAULT_CONFIG.retryableCodes,
      maxBodyChars: typeof raw?.maxBodyChars === "number" ? raw.maxBodyChars : DEFAULT_CONFIG.maxBodyChars,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function responseMatches(response: Response, bodyText: string, config: Required<RetryEnhanceConfig>): boolean {
  const normalized = bodyText.slice(0, config.maxBodyChars).trim();
  if (!normalized) return false;

  const payload = safeJsonParse(bodyText);
  const code = String(payload?.error?.code ?? payload?.code ?? "").toLowerCase();

  const statusMatches = config.retryableStatusCodes.includes(response.status);

  const patternMatches = config.retryablePatterns.some((pattern) => {
    if (!pattern) return false;
    const regex = new RegExp(pattern, "i");
    return regex.test(normalized);
  });

  const codeMatches = config.retryableCodes.some((candidate) => candidate.toLowerCase() === code);

  return statusMatches || patternMatches || codeMatches;
}

export default function (pi: ExtensionAPI) {
  const originalFetch = globalThis.fetch;
  const config = readConfig();

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return originalFetch(input, init).then(async (response) => {
      if (response.status < 400) {
        return response;
      }

      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        return response;
      }

      if (config.hosts.length > 0 && !config.hosts.includes(hostname)) {
        return response;
      }

      const bodyText = await response.clone().text();
      if (!responseMatches(response, bodyText, config)) {
        return response;
      }

      const payload = safeJsonParse(bodyText);
      const code = payload?.error?.code ?? payload?.code ?? "";
      const message = payload?.error?.message ?? payload?.message ?? `Provider responded with status ${response.status}`;

      const rewritten = JSON.stringify({
        error: {
          ...(payload?.error ?? {}),
          code,
          message,
        },
      });

      return new Response(rewritten, {
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({
          ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
          "content-type": "application/json",
          "x-should-retry": "true",
        }),
      });
    });
  };

  pi.on("session_shutdown", () => {
    globalThis.fetch = originalFetch;
  });
}
