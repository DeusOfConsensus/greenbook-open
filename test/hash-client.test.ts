import { describe, expect, it, vi } from 'vitest';
import { HttpError, PoliteClient, RobotsError } from '../src/fetch/client.js';
import { canonicalJson, recordHash, snapshotContentHash } from '../src/hash.js';

describe('hashing', () => {
  it('canonical JSON ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1, z: undefined }));
  });
  it('record hash depends on id and content', () => {
    expect(recordHash('1', { a: 1 })).toBe(recordHash('1', { a: 1 }));
    expect(recordHash('1', { a: 1 })).not.toBe(recordHash('2', { a: 1 }));
    expect(recordHash('1', { a: 1 })).not.toBe(recordHash('1', { a: 2 }));
  });
  it('snapshot hash is independent of input order and sensitive to content', () => {
    const a = snapshotContentHash([['2', 'h2'], ['1', 'h1'], ['10', 'h10']]);
    expect(snapshotContentHash([['10', 'h10'], ['1', 'h1'], ['2', 'h2']])).toBe(a);
    expect(snapshotContentHash([['10', 'h10'], ['1', 'h1'], ['2', 'hX']])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('snapshot hash format is pinned: sha256 of "id<TAB>hash<LF>" lines (changing it breaks every published hash)', () => {
    // Value computed independently with: printf '1\taa\n2\tbb\n' | sha256sum
    expect(snapshotContentHash([['1', 'aa'], ['2', 'bb']])).toBe(
      'e0d12dc51e5c3fd00961b2db860cf39f6f6a88d30789bd3b70b06b5657baa391',
    );
  });
});

function fakeWorld() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

const resp = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body, { status, headers });
const ROBOTS_OPEN = () => resp(200, 'User-agent: *\nDisallow:\n');

function client(fetchImpl: typeof fetch, w = fakeWorld(), extra: Record<string, unknown> = {}) {
  return {
    w,
    c: new PoliteClient({
      userAgent: 'greenbook-open/0.1 (+https://github.com/x/greenbook-open)',
      minDelayMs: 1000, jitterMs: 0, random: () => 0, fetchImpl, sleep: w.sleep, now: w.now, ...extra,
    }),
  };
}

describe('PoliteClient', () => {
  it('sends the repo-linked user-agent', async () => {
    const seen: string[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)['User-Agent']));
      return String(url).endsWith('robots.txt') ? ROBOTS_OPEN() : resp(200, '{"ok":true}');
    }) as unknown as typeof fetch;
    const { c } = client(f);
    await c.getJson('https://example.test/a');
    expect(seen.every((u) => u.includes('+https://github.com/x/greenbook-open'))).toBe(true);
  });

  it('waits at least the minimum delay between requests, including the robots.txt fetch', async () => {
    const f = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('robots.txt') ? ROBOTS_OPEN() : resp(200, '{}'))) as unknown as typeof fetch;
    const { c, w } = client(f);
    await c.getJson('https://example.test/a');
    await c.getJson('https://example.test/b');
    expect(c.requestCount).toBe(3); // robots + 2 pages
    expect(w.sleeps.length).toBe(2);
    expect(w.sleeps.every((s) => s >= 1000)).toBe(true);
  });

  it('refuses paths robots.txt disallows, without requesting them', async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('robots.txt') ? resp(200, 'User-agent: *\nDisallow: /private\n') : resp(200, 'secret'),
    ) as unknown as typeof fetch;
    const { c } = client(f);
    await expect(c.getText('https://example.test/private/x')).rejects.toBeInstanceOf(RobotsError);
    expect(f).toHaveBeenCalledTimes(1); // only robots.txt
    await expect(c.getText('https://example.test/public')).resolves.toBe('secret');
  });

  it('honours Crawl-delay when it is longer than the configured delay', async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('robots.txt') ? resp(200, 'User-agent: *\nCrawl-delay: 5\n') : resp(200, '{}'),
    ) as unknown as typeof fetch;
    const { c, w } = client(f);
    await c.getJson('https://example.test/a');
    await c.getJson('https://example.test/b');
    expect(Math.min(...w.sleeps)).toBeGreaterThanOrEqual(5000);
  });

  it('treats a missing robots.txt as allow-all but a robots.txt server error as a stop sign', async () => {
    const f404 = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('robots.txt') ? resp(404) : resp(200, 'ok'))) as unknown as typeof fetch;
    await expect(client(f404).c.getText('https://example.test/a')).resolves.toBe('ok');
    const f500 = vi.fn(async () => resp(503)) as unknown as typeof fetch;
    await expect(client(f500).c.getText('https://example.test/a')).rejects.toBeInstanceOf(RobotsError);
  });

  it('retries 503 with backoff and then succeeds', async () => {
    let n = 0;
    const f = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('robots.txt')) return ROBOTS_OPEN();
      return ++n < 3 ? resp(503) : resp(200, '{"done":true}');
    }) as unknown as typeof fetch;
    const { c, w } = client(f);
    await expect(c.getJson('https://example.test/a')).resolves.toEqual({ done: true });
    expect(n).toBe(3);
    expect(w.sleeps.some((s) => s >= 1000)).toBe(true);
  });

  it('honours Retry-After on 429', async () => {
    let n = 0;
    const f = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('robots.txt')) return ROBOTS_OPEN();
      return ++n === 1 ? resp(429, '', { 'retry-after': '7' }) : resp(200, '{}');
    }) as unknown as typeof fetch;
    const { c, w } = client(f);
    await c.getJson('https://example.test/a');
    expect(w.sleeps.some((s) => s >= 7000)).toBe(true);
  });

  it('gives up after maxRetries and does not retry client errors', async () => {
    const always503 = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('robots.txt') ? ROBOTS_OPEN() : resp(503))) as unknown as typeof fetch;
    await expect(client(always503, fakeWorld(), { maxRetries: 2 }).c.getText('https://example.test/a')).rejects.toBeInstanceOf(HttpError);
    expect((always503 as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1 + 3); // robots + 1 try + 2 retries

    const f404 = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('robots.txt') ? ROBOTS_OPEN() : resp(404))) as unknown as typeof fetch;
    await expect(client(f404).c.getText('https://example.test/a')).rejects.toMatchObject({ status: 404 });
    expect((f404 as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
