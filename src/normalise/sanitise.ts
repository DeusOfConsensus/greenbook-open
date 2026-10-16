import { keyify } from './text.js';

/**
 * Free-text contact details are never stored. Matching is on the normalised key name,
 * so "Contact Email", "applicant_phone" and "Manufacturer Address" are all dropped.
 */
const CONTACT_KEY = /(e-?mail|phone|mobile|fax|contact|address|whatsapp|website|^tel(ephone|no|number)?$)/;

/**
 * Keys whose values change on every fetch without the register changing. Left in, they
 * would give every record a new hash each snapshot and defeat de-duplication and diffing.
 * `dataqualitynote` is a scraper's own annotation, not register data.
 */
const VOLATILE_KEY = new Set([
  'fetchedat', 'scrapedat', 'scrapeddate', 'dtrowindex', 'rowindex', 'rownumber', 'sourceurl',
  'dataqualitynote', 'draw',
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface Sanitised {
  cleaned: Record<string, unknown>;
  /** Number of contact fields dropped or email addresses redacted. */
  strippedContact: number;
}

export function sanitiseFields(fields: Record<string, unknown>): Sanitised {
  let stripped = 0;

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      // eslint-disable-next-line no-control-regex
      const noNul = value.replace(/\u0000/g, '');
      return noNul.replace(EMAIL, () => {
        stripped++;
        return '[redacted-email]';
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const key = keyify(k);
        if (VOLATILE_KEY.has(key)) continue;
        if (CONTACT_KEY.test(key)) {
          stripped++;
          continue;
        }
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return { cleaned: walk(fields) as Record<string, unknown>, strippedContact: stripped };
}
