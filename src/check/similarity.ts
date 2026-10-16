// Words that say nothing about *which* product it is. Dropped before comparing names so
// "Amoxil 500mg Capsules" and "AMOXIL" are recognised as the same product.
const STOP = new Set([
  'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps', 'syrup', 'suspension',
  'injection', 'inj', 'solution', 'cream', 'ointment', 'gel', 'drops', 'powder', 'sachet',
  'sachets', 'oral', 'for', 'and', 'the', 'of', 'ltd', 'limited', 'plc', 'nigeria',
]);

const STRENGTH_TOKEN = /^\d+(?:\.\d+)?(?:mg|g|mcg|ug|ml|l|iu|%)?$/;

export function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.%\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t !== '' && !STOP.has(t) && !STRENGTH_TOKEN.test(t));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * Name similarity in [0, 1]. The larger of:
 *  - character-bigram Dice on the cleaned names (forgives typos and spacing), and
 *  - 0.95 x token containment (every distinctive word of the shorter name appears in the other).
 * Names that reduce to nothing after cleaning score 0.
 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  const containment = shared / Math.min(sa.size, sb.size);
  return Math.max(dice(ta.join(' '), tb.join(' ')), containment * 0.95);
}

/** True when the strings differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
