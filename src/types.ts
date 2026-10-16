export type StatusNorm =
  | 'active'
  | 'inactive'
  | 'expired'
  | 'suspended'
  | 'withdrawn'
  | 'cancelled'
  | 'unknown';

/** A record as it comes out of a source, before any cleaning. */
export interface RawRecord {
  sourceId: string;
  fields: Record<string, unknown>;
}

export interface StrengthComponent {
  value: number;
  unit: string;
  /** Present for per-volume strengths such as 250 mg per 5 ml. */
  perValue?: number;
  perUnit?: string;
}

export interface NormalisedRecord {
  sourceId: string;
  regNo: string | null;
  regNoKey: string | null;
  productName: string | null;
  productNameNorm: string | null;
  ingredients: string[];
  ingredientsText: string | null;
  dosageForm: string | null;
  dosageFormNorm: string | null;
  strengthText: string | null;
  strengths: StrengthComponent[];
  manufacturer: string | null;
  manufacturerNorm: string | null;
  applicant: string | null;
  applicantNorm: string | null;
  category: string | null;
  atcCodes: string[];
  approvedOn: string | null;
  expiresOn: string | null;
  status: string | null;
  statusNorm: StatusNorm;
  issues: string[];
}

/** A product as returned by queries and the API (snake_case mirrors the database). */
export interface ProductRow {
  source_id: string;
  reg_no: string | null;
  product_name: string | null;
  ingredients: string[];
  ingredients_text: string | null;
  dosage_form: string | null;
  strength_text: string | null;
  strengths: StrengthComponent[];
  manufacturer: string | null;
  applicant: string | null;
  category: string | null;
  atc_codes: string[];
  approved_on: string | null;
  expires_on: string | null;
  status: string | null;
  status_norm: StatusNorm;
  issues: string[];
}

export interface SnapshotMeta {
  id: number;
  taken_at: string;
  last_confirmed_at: string;
  confirm_count: number;
  source: string;
  record_count: number;
  content_hash: string;
  hash_version: number;
  notes: Record<string, unknown>;
}
