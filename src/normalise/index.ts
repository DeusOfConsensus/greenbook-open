import type { NormalisedRecord, RawRecord } from '../types.js';
import { parseDate } from './dates.js';
import { parseIngredients } from './ingredients.js';
import {
  normaliseDosageForm,
  normaliseOrg,
  normaliseRegNo,
  normaliseStatus,
  parseAtc,
} from './codes.js';
import { parseStrength } from './strength.js';
import { cleanText, keyify } from './text.js';

/** Bump when normalisation logic changes; `renormalise` rebuilds older rows from raw. */
export const NORMALISER_VERSION = 1;

type Canonical =
  | 'productId' | 'regNo' | 'productName' | 'ingredients' | 'dosageForm' | 'strength'
  | 'manufacturer' | 'applicant' | 'category' | 'atc' | 'approvedOn' | 'expiresOn' | 'status';

/**
 * Which raw field names feed each canonical field, tried in order, case and punctuation
 * ignored. Covers the Greenbook table headers (NRN, Form, Strengths, Applicant Name,
 * Approval Date...) and the camelCase names used by the Apify scraper's dataset
 * (registrationNumber, activeIngredients, approvedAt...). If a real fetch reveals other
 * names, add them here: this list is the only place field names live.
 */
export const ALIASES: Record<Canonical, string[]> = {
  productId: ['productid', 'id', 'pid', 'dtrowid'],
  regNo: ['registrationnumber', 'nrn', 'nafdacregno', 'nafdacregistrationnumber', 'regno',
    'registrationno', 'nafdacno', 'nafdacnumber'],
  productName: ['productname', 'name', 'brandname', 'brand'],
  ingredients: ['activeingredients', 'activeingredient', 'ingredients', 'api', 'genericname'],
  dosageForm: ['dosageform', 'form'],
  strength: ['strength', 'strengths'],
  manufacturer: ['manufacturer', 'manufacturername'],
  applicant: ['applicant', 'applicantname'],
  category: ['category', 'productcategory'],
  atc: ['atccode', 'atccodes', 'atc'],
  approvedOn: ['approvedat', 'approvaldate', 'dateapproved', 'approveddate', 'registrationdate',
    'dateofregistration'],
  expiresOn: ['expiresat', 'expirydate', 'expirationdate', 'dateexpired', 'expires', 'expiry'],
  status: ['status', 'registrationstatus', 'productstatus'],
};

function indexFields(fields: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    const key = keyify(k);
    if (!m.has(key)) m.set(key, v);
  }
  return m;
}

function pick(index: Map<string, unknown>, field: Canonical): unknown {
  for (const alias of ALIASES[field]) {
    if (index.has(alias)) return index.get(alias);
  }
  return undefined;
}

/** Find the product id inside a raw row, or null when the row has none. */
export function extractSourceId(fields: Record<string, unknown>): string | null {
  const v = pick(indexFields(fields), 'productId');
  const s = cleanText(v);
  return s === null ? null : s;
}

/** Clean and structure one raw record. Pure and deterministic: no clock, no network. */
export function normaliseRecord(rec: RawRecord): NormalisedRecord {
  const f = indexFields(rec.fields);
  const issues: string[] = [];

  const { regNo, regNoKey } = normaliseRegNo(pick(f, 'regNo'));
  if (regNo === null) issues.push('reg_no.missing');

  const productName = cleanText(pick(f, 'productName'));

  const ing = parseIngredients(pick(f, 'ingredients'));
  if (ing.names.length === 0) issues.push('ingredients.empty');

  const dosageForm = cleanText(pick(f, 'dosageForm'));

  const strengthText = cleanText(pick(f, 'strength'));
  const st = parseStrength(strengthText);
  if (strengthText !== null && !st.parsed) issues.push('strength.unparsed');
  if (
    st.parsed &&
    ing.names.length > 1 &&
    st.components.length > 0 &&
    st.components.length !== ing.names.length
  ) {
    issues.push('strength.ingredient_count_mismatch');
  }

  const manufacturer = cleanText(pick(f, 'manufacturer'));
  const applicant = cleanText(pick(f, 'applicant'));
  const category = cleanText(pick(f, 'category'));

  const atcRaw = pick(f, 'atc');
  const atc = parseAtc(atcRaw);
  if (atc.invalid.length > 0) issues.push('atc.invalid');

  const approved = parseDate(pick(f, 'approvedOn'));
  if (approved.issue) issues.push(`date.approval.${approved.issue}`);
  const expires = parseDate(pick(f, 'expiresOn'));
  if (expires.issue) issues.push(`date.expiry.${expires.issue}`);
  if (approved.iso && expires.iso && expires.iso < approved.iso) {
    issues.push('date.expiry_before_approval');
  }

  const status = normaliseStatus(pick(f, 'status'));
  if (status.status === null) issues.push('status.missing');
  if (status.unmapped) issues.push('status.unmapped');

  return {
    sourceId: rec.sourceId,
    regNo,
    regNoKey,
    productName,
    productNameNorm: productName === null ? null : productName.toLowerCase(),
    ingredients: ing.names,
    ingredientsText: ing.text,
    dosageForm,
    dosageFormNorm: normaliseDosageForm(dosageForm),
    strengthText,
    strengths: st.components,
    manufacturer,
    manufacturerNorm: normaliseOrg(manufacturer),
    applicant,
    applicantNorm: normaliseOrg(applicant),
    category,
    atcCodes: atc.codes,
    approvedOn: approved.iso,
    expiresOn: expires.iso,
    status: status.status,
    statusNorm: status.statusNorm,
    issues,
  };
}
