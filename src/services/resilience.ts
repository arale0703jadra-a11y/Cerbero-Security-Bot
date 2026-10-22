export type ErrorClass = "transient" | "permanent";

export interface ServiceHealth {
  status: "healthy" | "degraded";
  consecutiveFailures: number;
  lastErrorClass?: ErrorClass;
  lastError?: string;
  updatedAt: string;
}

const health = new Map<string, ServiceHealth>();

export function classifyError(error: unknown): ErrorClass {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  } | null;
  const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  const status = Number(candidate?.status ?? candidate?.statusCode);
  const message = typeof candidate?.message === "string"
    ? candidate.message.toLowerCase()
    : String(error).toLowerCase();

  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(code) ||
    /\b(timeout|timed out|temporarily unavailable|network|connection reset|connection refused)\b/.test(message)
  ) {
    return "transient";
  }
  return "permanent";
}

export async function withControlledRetries<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 100);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 1_000);
  const delay = options.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || classifyError(error) === "permanent") throw error;
      const waitMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await delay(waitMs);
    }
  }
}

export function recordServiceHealth(
  component: string,
  error?: unknown,
): ServiceHealth {
  const previous = health.get(component);
  const state: ServiceHealth = error === undefined
    ? {
        status: "healthy",
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
      }
    : {
        status: "degraded",
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        lastErrorClass: classifyError(error),
        lastError: safeErrorMessage(error),
        updatedAt: new Date().toISOString(),
      };
  health.set(component, state);
  return { ...state };
}

export function getServiceHealth(component: string): ServiceHealth {
  return { ...(health.get(component) ?? {
    status: "healthy",
    consecutiveFailures: 0,
    updatedAt: new Date().toISOString(),
  }) };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\b(bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, "$1=[REDACTED]")
    .slice(0, 200);
}
