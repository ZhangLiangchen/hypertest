export interface GitLabClientOptions {
  readonly baseUrl?: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export class GitLabClient {
  private readonly baseUrl: string;

  public constructor(private readonly options: GitLabClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/$/, "");
  }

  public async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  ): Promise<T> {
    const response = await this.request(method, path, body, query);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  public async requestBytes(
    method: string,
    path: string,
    query?: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  ): Promise<Uint8Array> {
    const response = await this.request(method, path, undefined, query);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, raw] of Object.entries(query ?? {})) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) url.searchParams.append(key, String(value));
    }

    const maxRetries = this.options.maxRetries ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      timeout.unref();
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "PRIVATE-TOKEN": this.options.token,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        if (response.ok) return response;
        const text = await response.text();
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 0);
          await delay(retryAfter > 0 ? retryAfter * 1_000 : 250 * 2 ** attempt);
          continue;
        }
        throw new Error(`GitLab API ${method} ${url.pathname} failed (${response.status}): ${text}`);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetryableError(error)) throw error;
        await delay(250 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

export function encodeProjectId(projectId: string | number): string {
  return encodeURIComponent(String(projectId));
}

function isRetryableError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError");
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
