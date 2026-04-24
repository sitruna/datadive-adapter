import { ZodSchema } from "zod";
import { BASE_URL, DEFAULT_TIMEOUT_MS } from "../constants.js";
import { TokenBucket } from "../utils/rate-limit.js";

export class DataDiveApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "DataDiveApiError";
  }
}

type RetryPolicy = "safe" | "rate-limit-only";

export class DataDiveClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly bucket: TokenBucket;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    bucket?: TokenBucket;
  }) {
    this.apiKey =
      opts?.apiKey ?? process.env.DATADIVE_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error(
        "DATADIVE_API_KEY is required. Set it as an environment variable or pass it to the constructor."
      );
    }
    this.baseUrl = opts?.baseUrl ?? BASE_URL;
    this.timeoutMs =
      opts?.timeoutMs ??
      (Number(process.env.DATADIVE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    this.bucket = opts?.bucket ?? new TokenBucket();
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    schema: ZodSchema<T>,
    policy: RetryPolicy
  ): Promise<T> {
    await this.bucket.acquire();

    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });

        if (!res.ok) {
          const body = await res.text().catch(() => undefined);
          const err = new DataDiveApiError(
            `DataDive API ${res.status}: ${res.statusText}`,
            res.status,
            body
          );
          if (canRetry(res.status, policy) && attempt < maxAttempts) {
            await sleep(retryDelayMs(res, attempt));
            lastErr = err;
            continue;
          }
          throw err;
        }

        const json = await res.json();
        return schema.parse(json);
      } catch (err) {
        if (err instanceof DataDiveApiError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          const timeoutErr = new DataDiveApiError(
            `DataDive API request timed out after ${this.timeoutMs}ms`,
            408
          );
          if (policy === "safe" && attempt < maxAttempts) {
            await sleep(backoffMs(attempt));
            lastErr = timeoutErr;
            continue;
          }
          throw timeoutErr;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("DataDive request failed");
  }

  async get<T>(
    path: string,
    schema: ZodSchema<T>,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }
    return this.request(
      url.toString(),
      { headers: { "x-api-key": this.apiKey } },
      schema,
      "safe"
    );
  }

  async post<T>(
    path: string,
    schema: ZodSchema<T>,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    return this.request(
      url.toString(),
      {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      schema,
      "rate-limit-only"
    );
  }

  async delete<T>(path: string, schema: ZodSchema<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    return this.request(
      url.toString(),
      { method: "DELETE", headers: { "x-api-key": this.apiKey } },
      schema,
      "rate-limit-only"
    );
  }
}

function canRetry(status: number, policy: RetryPolicy): boolean {
  if (status === 429) return true;
  if (policy === "safe") {
    return status === 408 || (status >= 500 && status < 600);
  }
  return false;
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
