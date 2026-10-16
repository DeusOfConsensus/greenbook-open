import { normaliseOrg, normaliseRegNo } from '../normalise/codes.js';
import { parseStrength } from '../normalise/strength.js';
import type { ProductRow, SnapshotMeta, StrengthComponent } from '../types.js';
import { nameTokens, similarity, withinOneEdit } from './similarity.js';

export type Verdict =
  | 'ok'
  | 'expired'
  | 'inactive'
  | 'unregistered'
  | 'mismatch'
  | 'ambiguous'
  | 'unverifiable';

/** fail = do not stock/import without resolving; warn = needs a human look; pass = fine. */
export type Severity = 'pass' | 'warn' | 'fail';

export interface CheckInput {
  /** Row number in the source file (the header is row 1). */
  row: number;
  regNo?: string;
  productName?: string;
  ingredient?: string;
  strength?: string;
  manufacturer?: string;
  dosageForm?: string;
}

export interface MatchInfo {
  source_id: string;
  reg_no: string | null;
  product_name: string | null;
  manufacturer: string | null;
  strength_text: string | null;
  status: string | null;
  status_norm: string;
  expires_on: string | null;
  similarity: number | null;
}

export interface CheckResult {
  row: number;
  input: CheckInput;
  verdict: Verdict;
  severity: Severity;
  reasons: string[];
  match: MatchInfo | null;
  /** Other plausible records: shared-number siblings, near-miss reg numbers, name matches. */
  candidates: MatchInfo[];
}

export interface CheckOptions {
  /** Date the checks are evaluated on (YYYY-MM-DD). */
  asOf: string;
  /** A name-only match must reach this similarity to be trusted. */
  nameMatchMin?: number;
  /** A reg number whose product name scores below this (with no ingredient overlap) is a mismatch. */
  mismatchBelow?: number;
  /** Warn when a registration expires within this many days. */
  expiringWithinDays?: number;
}

const DEFAULTS = { nameMatchMin: 0.85, mismatchBelow: 0.35, expiringWithinDays: 60 };
const BAD_STATUS = new Set(['inactive', 'suspended', 'withdrawn', 'cancelled']);

const DAY_MS = 86_400_000;
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);

/** In-memory view of one snapshot, built once and reused for every row checked. */
export class RegisterIndex {
  private readonly byRegKey = new Map<string, ProductRow[]>();
  private readonly byToken = new Map<string, number[]>();
  private readonly regKeys: string[];

  constructor(
    readonly snapshot: SnapshotMeta,
    private readonly rows: ProductRow[],
  ) {
    rows.forEach((row, i) => {
      const key = normaliseRegNo(row.reg_no).regNoKey;
      if (key) {
        const list = this.byRegKey.get(key);
        if (list) list.push(row);
        else this.byRegKey.set(key, [row]);
      }
      const toks = new Set([...nameTokens(row.product_name ?? ''), ...row.ingredients.flatMap(nameTokens)]);
      for (const t of toks) {
        const list = this.byToken.get(t);
        if (list) list.push(i);
        else this.byToken.set(t, [i]);
      }
    });
    this.regKeys = [...this.byRegKey.keys()];
  }

  get size(): number {
    return this.rows.length;
  }

  lookupReg(key: string): ProductRow[] {
    return this.byRegKey.get(key) ?? [];
  }

  /** Registered numbers one typo away from `key` ("did you mean"). */
  nearRegKeys(key: string, limit = 3): ProductRow[] {
    const out: ProductRow[] = [];
    for (const k of this.regKeys) {
      if (k !== key && withinOneEdit(k, key)) {
        out.push(...(this.byRegKey.get(k) ?? []));
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  /** Candidate rows sharing a distinctive word with the name, rarest words first. */
  candidatesByName(text: string, cap = 3000): ProductRow[] {
    const toks = [...new Set(nameTokens(text))]
      .filter((t) => this.byToken.has(t))
      .sort((a, b) => this.byToken.get(a)!.length - this.byToken.get(b)!.length)
      .slice(0, 3);
    const seen = new Set<number>();
    for (const t of toks) {
      for (const i of this.byToken.get(t)!) {
        seen.add(i);
        if (seen.size >= cap) break;
      }
    }
    return [...seen].map((i) => this.rows[i]!);
  }
}

function matchInfo(r: ProductRow, sim: number | null): MatchInfo {
  return {
    source_id: r.source_id,
    reg_no: r.reg_no,
    product_name: r.product_name,
    manufacturer: r.manufacturer ?? r.applicant,
    strength_text: r.strength_text,
    status: r.status,
    status_norm: r.status_norm,
    expires_on: r.expires_on,
    similarity: sim === null ? null : Math.round(sim * 100) / 100,
  };
}

interface Evaluation {
  verdict: Verdict;
  severity: Severity;
  reasons: string[];
}

/** Judge one matched register entry on its own: is it currently usable? */
function evaluate(rec: ProductRow, asOf: string, expiringWithinDays: number): Evaluation {
  const reasons: string[] = [];
  if (BAD_STATUS.has(rec.status_norm)) {
    return { verdict: 'inactive', severity: 'fail', reasons: [`register_status_${rec.status ?? rec.status_norm}`] };
  }
  if (rec.status_norm === 'expired') {
    return { verdict: 'expired', severity: 'fail', reasons: ['register_status_expired'] };
  }
  if (rec.expires_on && rec.expires_on < asOf) {
    return { verdict: 'expired', severity: 'fail', reasons: [`expired_on_${rec.expires_on}`] };
  }
  let severity: Severity = 'pass';
  if (rec.status_norm === 'unknown') {
    severity = 'warn';
    reasons.push(`status_unrecognised:${rec.status ?? 'missing'}`);
  }
  if (!rec.expires_on) {
    severity = 'warn';
    reasons.push('no_expiry_date_on_register');
  } else {
    const left = daysBetween(asOf, rec.expires_on);
    if (left <= expiringWithinDays) {
      severity = 'warn';
      reasons.push(`expires_in_${left}_days`);
    }
  }
  return { verdict: 'ok', severity, reasons };
}

const compKey = (c: StrengthComponent) => `${c.value}${c.unit}/${c.perValue ?? ''}${c.perUnit ?? ''}`;

/** Soft cross-checks on a matched record. These only ever add warnings. */
function softWarnings(rec: ProductRow, input: CheckInput): string[] {
  const w: string[] = [];
  if (input.manufacturer && (rec.manufacturer || rec.applicant)) {
    const a = normaliseOrg(input.manufacturer) ?? '';
    const regs = [rec.manufacturer, rec.applicant].map((x) => normaliseOrg(x) ?? '');
    const ok = regs.some((b) => b !== '' && (a.includes(b) || b.includes(a) || similarity(a, b) >= 0.6));
    if (!ok) w.push('manufacturer_differs');
  }
  if (input.strength && rec.strength_text) {
    const want = parseStrength(input.strength);
    const have = parseStrength(rec.strength_text);
    if (want.parsed && have.parsed) {
      const a = want.components.map(compKey).sort().join('|');
      const b = have.components.map(compKey).sort().join('|');
      if (a !== b) w.push('strength_differs');
    }
  }
  return w;
}

const worse = (a: Severity, b: Severity): Severity =>
  a === 'fail' || b === 'fail' ? 'fail' : a === 'warn' || b === 'warn' ? 'warn' : 'pass';

function checkOne(index: RegisterIndex, input: CheckInput, o: Required<CheckOptions>): CheckResult {
  const base = { row: input.row, input };
  const finish = (r: Omit<CheckResult, 'row' | 'input'>): CheckResult => ({ ...base, ...r });

  const regKey = normaliseRegNo(input.regNo).regNoKey;
  const name = input.productName?.trim() || undefined;

  // ---- Path 1: the row carries a registration number ----
  if (regKey) {
    const hits = index.lookupReg(regKey);

    if (hits.length === 0) {
      const near = index.nearRegKeys(regKey);
      return finish({
        verdict: 'unregistered',
        severity: 'fail',
        reasons: ['reg_no_not_on_register', ...(near.length ? ['near_reg_no_found'] : [])],
        match: null,
        candidates: near.map((r) => matchInfo(r, null)),
      });
    }

    let rec: ProductRow;
    const reasons: string[] = [];
    if (hits.length === 1) {
      rec = hits[0]!;
    } else {
      // The same number is on several register entries (a known Greenbook data issue).
      const scored = hits
        .map((r) => ({ r, s: name ? similarity(name, r.product_name) : 0 }))
        .sort((a, b) => b.s - a.s);
      const [best, second] = scored;
      if (name && best && best.s >= 0.6 && best.s - (second?.s ?? 0) >= 0.15) {
        rec = best.r;
        reasons.push(`reg_no_shared_by_${hits.length}_products`);
      } else {
        return finish({
          verdict: 'ambiguous',
          severity: 'warn',
          reasons: [`reg_no_shared_by_${hits.length}_products`, name ? 'name_does_not_single_one_out' : 'no_product_name_to_disambiguate'],
          match: null,
          candidates: scored.slice(0, 10).map(({ r, s }) => matchInfo(r, name ? s : null)),
        });
      }
    }

    const sim = name ? similarity(name, rec.product_name) : null;
    if (name && sim !== null && sim < o.mismatchBelow) {
      // A different name is fine if the ingredient lines up ("Amoxicillin 500mg caps" vs brand AMOXIL).
      const hay = `${name} ${input.ingredient ?? ''}`.toLowerCase();
      const corroborated = rec.ingredients.some((ing) => ing.length >= 4 && hay.includes(ing));
      if (!corroborated) {
        return finish({
          verdict: 'mismatch',
          severity: 'fail',
          reasons: ['reg_no_belongs_to_a_different_product'],
          match: matchInfo(rec, sim),
          candidates: [],
        });
      }
      reasons.push('name_differs_but_ingredient_matches');
    }

    const ev = evaluate(rec, o.asOf, o.expiringWithinDays);
    const soft = softWarnings(rec, input);
    const warnSeverity: Severity = reasons.length > 0 || soft.length > 0 ? 'warn' : 'pass';
    return finish({
      verdict: ev.verdict,
      severity: worse(ev.severity, warnSeverity),
      reasons: [...ev.reasons, ...reasons, ...soft],
      match: matchInfo(rec, sim),
      candidates: [],
    });
  }

  // ---- Path 2: no registration number, so try to find the product by name ----
  if (!name) {
    return finish({ verdict: 'unverifiable', severity: 'warn', reasons: ['row_has_no_reg_no_or_product_name'], match: null, candidates: [] });
  }

  const scored = index
    .candidatesByName(`${name} ${input.ingredient ?? ''}`)
    .map((r) => {
      let s = similarity(name, r.product_name);
      // Small tie-breakers so the right strength/form/maker wins among same-name entries.
      if (input.dosageForm && r.dosage_form && r.dosage_form.toLowerCase().includes(input.dosageForm.toLowerCase())) s += 0.02;
      if (input.strength && r.strength_text && parseStrength(input.strength).components.map(compKey).sort().join('|') ===
          parseStrength(r.strength_text).components.map(compKey).sort().join('|')) s += 0.03;
      return { r, s };
    })
    .filter((x) => x.s > 0.3)
    .sort((a, b) => b.s - a.s);

  const top = scored[0];
  if (top && top.s >= o.nameMatchMin) {
    const runnerUp = scored[1];
    const rivals = runnerUp !== undefined && top.s - runnerUp.s < 0.02 && runnerUp.r.reg_no !== top.r.reg_no;
    const ev = evaluate(top.r, o.asOf, o.expiringWithinDays);
    return finish({
      verdict: ev.verdict,
      severity: worse(ev.severity, 'warn'), // matched without a number, so never a clean pass
      reasons: [...ev.reasons, 'matched_by_name_no_reg_no', ...(rivals ? ['multiple_equally_good_name_matches'] : []), ...softWarnings(top.r, input)],
      match: matchInfo(top.r, top.s),
      candidates: scored.slice(1, 4).map(({ r, s }) => matchInfo(r, s)),
    });
  }

  return finish({
    verdict: 'unverifiable',
    severity: 'warn',
    reasons: ['no_reg_no_and_no_confident_name_match'],
    match: null,
    candidates: scored.slice(0, 5).map(({ r, s }) => matchInfo(r, s)),
  });
}

export function checkItems(index: RegisterIndex, inputs: CheckInput[], opts: CheckOptions): CheckResult[] {
  const o = { ...DEFAULTS, ...opts } as Required<CheckOptions>;
  return inputs.map((i) => checkOne(index, i, o));
}

export interface CheckSummary {
  total: number;
  by_verdict: Record<string, number>;
  by_severity: Record<Severity, number>;
}

export function summarise(results: CheckResult[]): CheckSummary {
  const by_verdict: Record<string, number> = {};
  const by_severity: Record<Severity, number> = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) {
    by_verdict[r.verdict] = (by_verdict[r.verdict] ?? 0) + 1;
    by_severity[r.severity]++;
  }
  return { total: results.length, by_verdict, by_severity };
}
