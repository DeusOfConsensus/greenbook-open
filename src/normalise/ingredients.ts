import { cleanText } from './text.js';

// Pharmacopoeia suffixes: "Paracetamol BP", "Metformin Hydrochloride USP".
const PHARMACOPOEIA = /\s+(?:b\.?p\.?|u\.?s\.?p\.?|i\.?p\.?|e\.?p\.?|j\.?p\.?|n\.?f\.?|ph\.?\s?eur\.?)\s*$/i;

/** Split on separators that sit outside brackets, so "Sodium chloride (as a, b)" stays whole. */
function splitTopLevel(s: string, separators: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.has(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function splitIngredientString(s: string): string[] {
  const parts = splitTopLevel(s, new Set([';', ',', '+', '/', '&'])).filter((p) => p.trim() !== '');
  // "Amoxicillin and Clavulanic Acid": only split on "and" when nothing else separated the list.
  if (parts.length === 1) {
    return (parts[0] ?? '').split(/\s+and\s+/i);
  }
  return parts;
}

/** "Amoxicillin (as trihydrate) BP" -> "amoxicillin". Qualifiers stay in ingredients_text. */
export function canonIngredient(part: string): string | null {
  let t = part.replace(/\s*\([^)]*\)/g, ' ').replace(/\s*\[[^\]]*\]/g, ' ');
  if (t.trim() === '') t = part.replace(/[()[\]]/g, ' '); // the whole thing was bracketed
  t = t.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2 && PHARMACOPOEIA.test(t); i++) t = t.replace(PHARMACOPOEIA, '');
  t = t.replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, '').toLowerCase();
  return t === '' ? null : t;
}

export interface IngredientResult {
  /** Lower-case base names in source order (order matters for pairing with strengths). */
  names: string[];
  /** The full ingredient text as given, joined with "; " when the source supplied a list. */
  text: string | null;
}

/** Accepts either a structured list (["Artemether", "Lumefantrine"]) or a delimited string. */
export function parseIngredients(input: unknown): IngredientResult {
  let parts: string[];
  let text: string | null;

  if (Array.isArray(input)) {
    parts = input.map(cleanText).filter((x): x is string => x !== null);
    text = parts.length > 0 ? parts.join('; ') : null;
  } else {
    text = cleanText(input);
    parts = text === null ? [] : splitIngredientString(text);
  }

  const names: string[] = [];
  for (const p of parts) {
    const n = canonIngredient(p);
    if (n !== null && !names.includes(n)) names.push(n);
  }
  return { names, text };
}
