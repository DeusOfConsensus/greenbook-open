import { cleanText } from './text.js';

export type DateIssue = 'unparseable' | 'sentinel';

export interface DateResult {
  iso: string | null;
  issue: DateIssue | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function validCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function finish(y: number, m: number, d: number): DateResult {
  // NAFDAC was founded in 1993, so anything before 1990 or after 2100 is a placeholder
  // (0000-00-00, 1900-01-01, 9999-12-31 and similar), not a real registration date.
  if (y < 1990 || y > 2100) return { iso: null, issue: 'sentinel' };
  if (!validCalendarDate(y, m, d)) return { iso: null, issue: 'unparseable' };
  return { iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, issue: null };
}

/**
 * Parse the date formats seen in Nigerian regulatory data into an ISO date (YYYY-MM-DD).
 * Numeric formats with a leading day (26/08/2026) are read day-first. A time or timezone
 * suffix is ignored and the literal date part is kept, so no timezone shifting happens.
 * Empty input gives { iso: null, issue: null }; junk gives an issue code.
 */
export function parseDate(input: unknown): DateResult {
  const s = cleanText(input);
  if (s === null) return { iso: null, issue: null };

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return finish(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ,].*)?$/.exec(s);
  if (m) return finish(Number(m[3]), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})(?:st|nd|rd|th)?[-\s/]+([A-Za-z]{3,9})\.?,?[-\s/]+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[(m[2] ?? '').toLowerCase()];
    if (mon) return finish(Number(m[3]), mon, Number(m[1]));
  }

  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[(m[1] ?? '').toLowerCase()];
    if (mon) return finish(Number(m[3]), mon, Number(m[2]));
  }

  return { iso: null, issue: 'unparseable' };
}
