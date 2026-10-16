import { readFileSync } from 'node:fs';
import { z } from 'zod';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION: string = pkg.version;

/** Hard floor on the delay between requests to NAFDAC. Configurable upwards only. */
export const MIN_DELAY_FLOOR_MS = 1000;

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('pglite://./data/greenbook'),
  GBO_BASE_URL: z.string().url().default('https://greenbook.nafdac.gov.ng'),
  GBO_REPO_URL: z.string().url().default('https://github.com/DeusOfConsensus/greenbook-open'),
  GBO_MIN_DELAY_MS: z.coerce.number().int().min(MIN_DELAY_FLOOR_MS).default(2000),
  GBO_PAGE_SIZE: z.coerce.number().int().min(1).max(5000).default(1000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
});

export interface Config {
  databaseUrl: string;
  baseUrl: string;
  repoUrl: string;
  userAgent: string;
  minDelayMs: number;
  pageSize: number;
  port: number;
  host: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    baseUrl: e.GBO_BASE_URL.replace(/\/+$/, ''),
    repoUrl: e.GBO_REPO_URL,
    // The repo URL in the user-agent lets NAFDAC's operators see who is fetching and why.
    userAgent: `greenbook-open/${VERSION} (+${e.GBO_REPO_URL})`,
    minDelayMs: e.GBO_MIN_DELAY_MS,
    pageSize: e.GBO_PAGE_SIZE,
    port: e.PORT,
    host: e.HOST,
  };
}
