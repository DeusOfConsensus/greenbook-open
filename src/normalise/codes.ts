import type { StatusNorm } from '../types.js';
import { cleanText } from './text.js';

// ---------- Registration numbers ----------

export interface RegNo {
  regNo: string | null;
  /** Upper-case alphanumerics only: "A4-0123", "a4 0123" and "A40123" all share one key. */
  regNoKey: string | null;
}

export function normaliseRegNo(input: unknown): RegNo {
  const t = cleanText(input);
  if (t === null) return { regNo: null, regNoKey: null };
  const regNo = t.toUpperCase().replace(/\s*-\s*/g, '-');
  const key = regNo.replace(/[^A-Z0-9]/g, '');
  return { regNo, regNoKey: key === '' ? null : key };
}

/** "B4-7079" -> "A9-9999". Used by the quality report to show which formats are in use. */
export function regNoShape(regNo: string): string {
  return regNo.replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9');
}

// ---------- ATC codes ----------

// Levels 1-5: A, A10, A10B, A10BA, A10BA02. First letter must be a real anatomical group.
const ATC = /^[ABCDGHJLMNPRSV](?:\d{2}(?:[A-Z](?:[A-Z](?:\d{2})?)?)?)?$/;

export interface AtcResult {
  codes: string[];
  invalid: string[];
}

export function parseAtc(input: unknown): AtcResult {
  const t = cleanText(input);
  if (t === null) return { codes: [], invalid: [] };
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const raw of t.split(/[,;/\s]+/)) {
    const c = raw.replace(/\./g, '').toUpperCase();
    if (c === '') continue;
    if (ATC.test(c)) {
      if (!codes.includes(c)) codes.push(c);
    } else {
      invalid.push(raw);
    }
  }
  return { codes, invalid };
}

// ---------- Status ----------

const STATUS_MAP: Record<string, StatusNorm> = {
  active: 'active', registered: 'active', valid: 'active', approved: 'active', current: 'active',
  inactive: 'inactive', dormant: 'inactive', lapsed: 'inactive',
  expired: 'expired',
  suspended: 'suspended',
  withdrawn: 'withdrawn', deregistered: 'withdrawn', 'de-registered': 'withdrawn', delisted: 'withdrawn',
  cancelled: 'cancelled', canceled: 'cancelled', revoked: 'cancelled',
};

export interface StatusResult {
  status: string | null;
  statusNorm: StatusNorm;
  /** True when a status was present but is not in our mapping table. */
  unmapped: boolean;
}

/**
 * The mapping table above is a best guess: the first real snapshot's quality report lists
 * every status value it could not map, so extend STATUS_MAP from real data, not from here.
 */
export function normaliseStatus(input: unknown): StatusResult {
  const status = cleanText(input);
  if (status === null) return { status: null, statusNorm: 'unknown', unmapped: false };
  const norm = STATUS_MAP[status.toLowerCase()];
  return norm
    ? { status, statusNorm: norm, unmapped: false }
    : { status, statusNorm: 'unknown', unmapped: true };
}

// ---------- Dosage form ----------

const FORM_TOKENS: Record<string, string> = {
  tablets: 'tablet', tabs: 'tablet', tab: 'tablet',
  capsules: 'capsule', caps: 'capsule', cap: 'capsule',
  injections: 'injection', inj: 'injection',
  suspensions: 'suspension', susp: 'suspension',
  solutions: 'solution', soln: 'solution', sol: 'solution',
  syrups: 'syrup', syr: 'syrup',
  suppositories: 'suppository', supp: 'suppository',
  ointments: 'ointment', oint: 'ointment',
  creams: 'cream', crm: 'cream',
  gels: 'gel', powders: 'powder', sachets: 'sachet', lozenges: 'lozenge',
  drops: 'drops', granules: 'granules',
};

export function normaliseDosageForm(input: unknown): string | null {
  const t = cleanText(input);
  if (t === null) return null;
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => FORM_TOKENS[w] ?? w)
    .join(' ');
}

// ---------- Organisations (manufacturers and applicants) ----------

const ORG_NOISE = new Set([
  'ltd', 'limited', 'plc', 'pvt', 'private', 'inc', 'incorporated', 'llc', 'llp', 'gmbh', 'ag',
  'sa', 'nv', 'bv', 'co', 'company', 'corp', 'corporation', 'nig', 'nigeria', 'the',
]);

/**
 * Grouping key for company names: "Ajanta Pharma Nigeria Limited" and "AJANTA PHARMA LTD."
 * both become "ajanta pharma". Used for matching and grouping only; the original is kept.
 */
export function normaliseOrg(input: unknown): string | null {
  const t = cleanText(input);
  if (t === null) return null;
  const key = t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !ORG_NOISE.has(w))
    .join(' ');
  return key === '' ? t.toLowerCase() : key;
}
