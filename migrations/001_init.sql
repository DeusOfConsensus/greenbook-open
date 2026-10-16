-- Greenbook Open schema, v1.
--
-- Design: records are content-addressed. record_hash = sha256 of the cleaned raw record
-- (including its product id), so a product that did not change costs zero new rows when a
-- new snapshot is taken. A snapshot is just a map of source_id -> record_hash plus a
-- content_hash over that whole map. That makes diffs a SQL join, and gives you a single
-- value per snapshot that can be signed, tagged in git, or anchored on-chain later.
--
-- The raw record is stored next to its normalised columns on purpose: when the normaliser
-- improves, `greenbook-open renormalise` rebuilds the columns from raw without refetching.

CREATE TABLE snapshots (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at          timestamptz NOT NULL,
  last_confirmed_at timestamptz NOT NULL,   -- latest time this exact content was re-observed
  confirm_count     integer NOT NULL DEFAULT 1,
  source            text NOT NULL,          -- e.g. 'greenbook-live' or 'file:snapshot.json'
  record_count      integer NOT NULL,
  content_hash      text NOT NULL,          -- sha256 over sorted (source_id, record_hash) pairs
  hash_version      integer NOT NULL DEFAULT 1,
  notes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_taken_at_idx ON snapshots (taken_at);
CREATE INDEX snapshots_content_hash_idx ON snapshots (content_hash);

CREATE TABLE records (
  record_hash        text PRIMARY KEY,
  source_id          text NOT NULL,
  raw                jsonb NOT NULL,        -- cleaned raw record (contact fields and volatile keys removed)
  normaliser_version integer NOT NULL,

  reg_no             text,
  reg_no_key         text,                  -- upper-case alphanumerics only, for forgiving matching
  product_name       text,
  product_name_norm  text,
  ingredients        text[] NOT NULL DEFAULT '{}',
  ingredients_text   text,
  dosage_form        text,
  dosage_form_norm   text,
  strength_text      text,
  strengths          jsonb NOT NULL DEFAULT '[]'::jsonb,
  manufacturer       text,
  manufacturer_norm  text,
  applicant          text,
  applicant_norm     text,
  category           text,
  atc_codes          text[] NOT NULL DEFAULT '{}',
  approved_on        date,
  expires_on         date,
  status             text,
  status_norm        text NOT NULL DEFAULT 'unknown',
  issues             text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX records_source_id_idx ON records (source_id);
CREATE INDEX records_reg_no_key_idx ON records (reg_no_key);
CREATE INDEX records_manufacturer_norm_idx ON records (manufacturer_norm);
CREATE INDEX records_applicant_norm_idx ON records (applicant_norm);
CREATE INDEX records_ingredients_gin ON records USING gin (ingredients);
CREATE INDEX records_atc_codes_gin ON records USING gin (atc_codes);

CREATE TABLE snapshot_records (
  snapshot_id integer NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  source_id   text NOT NULL,
  record_hash text NOT NULL REFERENCES records (record_hash),
  PRIMARY KEY (snapshot_id, source_id)
);
CREATE INDEX snapshot_records_hash_idx ON snapshot_records (record_hash);
