import { createRequire } from 'node:module';

// robots-parser is CommonJS with `export =`, which NodeNext cannot default-import cleanly.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (
  url: string,
  contents: string,
) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export class RobotsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobotsError';
  }
}

export interface ClientOptions {
  userAgent: string;
  /** Minimum gap between any two requests. Callers should never set this below 1000. */
  minDelayMs: number;
  /** Extra random delay added on top of minDelayMs, in ms. */
  jitterMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (msg: string) => void;
}

interface RobotsEntry {
  allows: (url: string) => boolean;
  crawlDelayMs: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * A deliberately slow, honest HTTP client:
 *  - one request at a time, with a minimum delay (plus jitter) between requests
 *  - identifies itself with a user-agent that links to the repo
 *  - checks robots.txt once per origin and honours Disallow and Crawl-delay
 *  - retries 429/5xx with exponential backoff and honours Retry-After
 */
export class PoliteClient {
  private readonly o: Required<Omit<ClientOptions, 'log'>> & { log: (m: string) => void };
  private lastRequestAt = 0;
  private hasRequested = false;
  private readonly robots = new Map<string, RobotsEntry>();
  requestCount = 0;

  constructor(opts: ClientOptions) {
    this.o = {
      jitterMs: 500,
      timeoutMs: 60_000,
      maxRetries: 4,
      respectRobots: true,
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      random: Math.random,
      log: () => undefined,
      ...opts,
    };
  }

  async getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.request(url, { Accept: 'application/json', ...headers });
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`Response from ${url} was not valid JSON`);
    }
  }

  async getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    return (await this.request(url, headers)).text();
  }

  private async throttle(crawlDelayMs: number): Promise<void> {
    const delay = Math.max(this.o.minDelayMs, crawlDelayMs) + this.o.random() * this.o.jitterMs;
    const wait = this.lastRequestAt + delay - this.o.now();
    if (this.hasRequested && wait > 0) await this.o.sleep(wait);
    this.hasRequested = true;
    this.lastRequestAt = this.o.now();
  }

  private async robotsFor(url: string): Promise<RobotsEntry> {
    const origin = new URL(url).origin;
    const cached = this.robots.get(origin);
    if (cached) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    await this.throttle(0);
    this.requestCount++;
    let res: Response;
    try {
      res = await this.o.fetchImpl(robotsUrl, {
        headers: { 'User-Agent': this.o.userAgent },
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      throw new RobotsError(`Could not fetch ${robotsUrl}: ${(err as Error).message}`);
    }

    let entry: RobotsEntry;
    if (res.status >= 500) {
      // RFC 9309: if robots.txt is unreachable due to a server error, assume full disallow.
      throw new RobotsError(`robots.txt returned HTTP ${res.status}; refusing to fetch until it recovers`);
    } else if (res.status >= 400) {
      entry = { allows: () => true, crawlDelayMs: 0 }; // no robots.txt: everything is allowed
    } else {
      const parser = robotsParser(robotsUrl, await res.text());
      const delay = parser.getCrawlDelay(this.o.userAgent);
      entry = {
        allows: (u) => parser.isAllowed(u, this.o.userAgent) !== false,
        crawlDelayMs: typeof delay === 'number' ? delay * 1000 : 0,
      };
    }
    this.robots.set(origin, entry);
    return entry;
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    let crawlDelayMs = 0;
    if (this.o.respectRobots) {
      const entry = await this.robotsFor(url);
      if (!entry.allows(url)) throw new RobotsError(`robots.txt disallows ${url}`);
      crawlDelayMs = entry.crawlDelayMs;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      if (attempt > 0) this.o.log(`retry ${attempt}/${this.o.maxRetries} for ${url}`);
      await this.throttle(crawlDelayMs);
      this.requestCount++;
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, {
          headers: { 'User-Agent': this.o.userAgent, ...headers },
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (err) {
        lastError = err; // network error or timeout: retry
        await this.o.sleep(this.backoff(attempt, null));
        continue;
      }
      if (res.ok) return res;
      if (RETRYABLE.has(res.status)) {
        lastError = new HttpError(res.status, url);
        await this.o.sleep(this.backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      throw new HttpError(res.status, url);
    }
    throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const exp = Math.min(60_000, 1000 * 2 ** attempt);
    if (!retryAfter) return exp;
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - this.o.now();
    return Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(ms, exp), 300_000) : exp;
  }
}
