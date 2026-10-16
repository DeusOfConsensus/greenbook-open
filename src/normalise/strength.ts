import type { StrengthComponent } from '../types.js';
import { cleanText } from './text.js';

const UNIT_MAP: Record<string, string> = {
  mg: 'mg', milligram: 'mg', milligrams: 'mg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  kg: 'kg',
  mcg: 'mcg', ug: 'mcg', 'µg': 'mcg', 'μg': 'mcg', microgram: 'mcg', micrograms: 'mcg',
  ng: 'ng',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  iu: 'iu', 'i.u': 'iu',
  unit: 'unit', units: 'unit', u: 'unit',
  '%': '%',
  mmol: 'mmol', meq: 'meq', mci: 'mci', mbq: 'mbq', cfu: 'cfu', ppm: 'ppm',
  dose: 'dose', doses: 'dose',
  tablet: 'tablet', tablets: 'tablet', tab: 'tablet',
  capsule: 'capsule', capsules: 'capsule',
  vial: 'vial', vials: 'vial',
  ampoule: 'ampoule', ampoules: 'ampoule', amp: 'ampoule',
  sachet: 'sachet', sachets: 'sachet',
  drop: 'drop', drops: 'drop',
  puff: 'puff', puffs: 'puff',
  actuation: 'actuation', actuations: 'actuation',
};

/** Units that measure an amount of substance. Two of these around a slash mean a combination. */
const AMOUNT_UNITS = new Set(['mg', 'g', 'kg', 'mcg', 'ng', 'iu', 'unit', 'mmol', 'meq', 'mci', 'mbq', 'cfu']);

const PART =
  /^(\d+(?:\.\d+)?)\s*([a-zA-Zµμ%.]+)(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-zA-Zµμ%.]+))?$/;

function unit(raw: string): string | null {
  return UNIT_MAP[raw.toLowerCase().replace(/\.$/, '')] ?? null;
}

export interface StrengthResult {
  components: StrengthComponent[];
  /** True when the text was non-empty and every part of it was understood. */
  parsed: boolean;
  /** Parts we could not understand, for the data-quality report. */
  unparsedParts: string[];
}

/**
 * Parse strength text into structured components.
 *   "500mg"            -> 500 mg
 *   "80mg; 480mg"      -> 80 mg, 480 mg          (combination products, in ingredient order)
 *   "250mg/5ml"        -> 250 mg per 5 ml
 *   "500mg/125mg"      -> 500 mg, 125 mg         (two amounts around a slash = combination)
 *   "5 mg/ml"          -> 5 mg per 1 ml
 *   "0.5% w/v"         -> 0.5 %
 * Anything else is reported as unparsed rather than guessed at.
 */
export function parseStrength(input: unknown): StrengthResult {
  const text = cleanText(input);
  if (text === null) return { components: [], parsed: false, unparsedParts: [] };

  const prepared = text
    .replace(/\b[wv]\s*\/\s*[wv]\b/gi, '') // drop w/v, w/w, v/v qualifiers
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2') // 1,000 -> 1000
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2'); // 0,5 -> 0.5

  const components: StrengthComponent[] = [];
  const unparsedParts: string[] = [];

  for (const part of prepared.split(/\s*(?:;|\+|,|&|\band\b)\s*/i)) {
    const p = part.trim();
    if (p === '') continue;
    const m = PART.exec(p);
    const u1 = m ? unit(m[2] ?? '') : null;
    if (!m || !u1) {
      unparsedParts.push(p);
      continue;
    }
    const value = Number(m[1]);
    const rawU2 = m[4];
    if (rawU2 === undefined) {
      components.push({ value, unit: u1 });
      continue;
    }
    const u2 = unit(rawU2);
    if (!u2) {
      unparsedParts.push(p);
      continue;
    }
    const n2 = m[3] !== undefined ? Number(m[3]) : undefined;
    if (n2 !== undefined && AMOUNT_UNITS.has(u1) && AMOUNT_UNITS.has(u2)) {
      components.push({ value, unit: u1 }, { value: n2, unit: u2 });
    } else {
      components.push({ value, unit: u1, perValue: n2 ?? 1, perUnit: u2 });
    }
  }

  return {
    components,
    parsed: components.length > 0 && unparsedParts.length === 0,
    unparsedParts,
  };
}
