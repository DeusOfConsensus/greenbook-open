import { describe, expect, it } from 'vitest';
import { normaliseDosageForm, normaliseOrg, normaliseRegNo, normaliseStatus, parseAtc, regNoShape } from '../src/normalise/codes.js';
import { parseDate } from '../src/normalise/dates.js';
import { parseIngredients } from '../src/normalise/ingredients.js';
import { extractSourceId, normaliseRecord } from '../src/normalise/index.js';
import { sanitiseFields } from '../src/normalise/sanitise.js';
import { parseStrength } from '../src/normalise/strength.js';
import { cleanText } from '../src/normalise/text.js';

describe('cleanText', () => {
  it('trims, collapses whitespace and maps placeholders to null', () => {
    expect(cleanText('  Hello \n  world ')).toBe('Hello world');
    for (const p of ['N/A', 'null', '-', '', '   ', 'None']) expect(cleanText(p)).toBeNull();
  });
  it('reads names out of {id, name} objects and joins arrays', () => {
    expect(cleanText({ id: 3, name: 'Ajanta' })).toBe('Ajanta');
    expect(cleanText(['a', null, 'b'])).toBe('a; b');
    expect(cleanText(42)).toBe('42');
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-08-26', '2026-08-26'],
    ['2026-08-26T23:30:00.000Z', '2026-08-26'],
    ['26/08/2026', '2026-08-26'],
    ['05-03-2025', '2025-03-05'], // day-first
    ['1 Mar 2025', '2025-03-01'],
    ['01-Mar-2025', '2025-03-01'],
    ['September 5, 2026', '2026-09-05'],
    ['5th September 2026', '2026-09-05'],
    ['29/02/2024', '2024-02-29'],
  ])('parses %s', (input, iso) => {
    expect(parseDate(input)).toEqual({ iso, issue: null });
  });
  it('flags placeholders and junk instead of guessing', () => {
    expect(parseDate('0000-00-00')).toEqual({ iso: null, issue: 'sentinel' });
    expect(parseDate('1900-01-01').issue).toBe('sentinel');
    expect(parseDate('9999-12-31').issue).toBe('sentinel');
    expect(parseDate('2026-02-30').issue).toBe('unparseable');
    expect(parseDate('29/02/2025').issue).toBe('unparseable');
    expect(parseDate('sometime in 2024').issue).toBe('unparseable');
  });
  it('treats empty input as simply absent', () => {
    expect(parseDate(null)).toEqual({ iso: null, issue: null });
    expect(parseDate('N/A')).toEqual({ iso: null, issue: null });
  });
});

describe('parseStrength', () => {
  it('parses single and combination strengths', () => {
    expect(parseStrength('500mg').components).toEqual([{ value: 500, unit: 'mg' }]);
    expect(parseStrength('80mg; 480mg').components).toEqual([{ value: 80, unit: 'mg' }, { value: 480, unit: 'mg' }]);
    expect(parseStrength('500mg/125mg').components).toEqual([{ value: 500, unit: 'mg' }, { value: 125, unit: 'mg' }]);
  });
  it('parses per-volume strengths', () => {
    expect(parseStrength('250mg/5ml').components).toEqual([{ value: 250, unit: 'mg', perValue: 5, perUnit: 'ml' }]);
    expect(parseStrength('5 mg/ml').components).toEqual([{ value: 5, unit: 'mg', perValue: 1, perUnit: 'ml' }]);
  });
  it('handles units, decimals and qualifiers', () => {
    expect(parseStrength('0.5% w/v').components).toEqual([{ value: 0.5, unit: '%' }]);
    expect(parseStrength('1,000 IU').components).toEqual([{ value: 1000, unit: 'iu' }]);
    expect(parseStrength('0,5mg').components).toEqual([{ value: 0.5, unit: 'mg' }]);
    expect(parseStrength('500 MG').components).toEqual([{ value: 500, unit: 'mg' }]);
    expect(parseStrength('200 mcg').components[0]!.unit).toBe('mcg');
  });
  it('reports what it could not understand rather than guessing', () => {
    const r = parseStrength('as directed');
    expect(r.parsed).toBe(false);
    expect(r.components).toEqual([]);
    expect(r.unparsedParts).toEqual(['as directed']);
    expect(parseStrength('500mg; lots').parsed).toBe(false);
    expect(parseStrength(null).parsed).toBe(false);
  });
});

describe('parseIngredients', () => {
  it('accepts structured lists and delimited strings', () => {
    expect(parseIngredients(['Artemether', 'Lumefantrine']).names).toEqual(['artemether', 'lumefantrine']);
    expect(parseIngredients('Artemether + Lumefantrine').names).toEqual(['artemether', 'lumefantrine']);
    expect(parseIngredients('Artemether; Lumefantrine').names).toEqual(['artemether', 'lumefantrine']);
  });
  it('strips salt qualifiers and pharmacopoeia suffixes but keeps the text', () => {
    const r = parseIngredients('Amoxicillin (as trihydrate) BP');
    expect(r.names).toEqual(['amoxicillin']);
    expect(r.text).toBe('Amoxicillin (as trihydrate) BP');
    expect(parseIngredients('Metformin Hydrochloride USP').names).toEqual(['metformin hydrochloride']);
  });
  it('splits "and" only when nothing else separated the list, and respects brackets', () => {
    expect(parseIngredients('Amoxicillin and Clavulanic Acid').names).toEqual(['amoxicillin', 'clavulanic acid']);
    expect(parseIngredients('Sodium chloride (as a, b)').names).toEqual(['sodium chloride']);
  });
  it('de-duplicates and handles empties', () => {
    expect(parseIngredients(['Paracetamol', 'paracetamol BP']).names).toEqual(['paracetamol']);
    expect(parseIngredients(null).names).toEqual([]);
  });
});

describe('codes', () => {
  it('normalises registration numbers and keys them for forgiving matching', () => {
    expect(normaliseRegNo('b4-7079')).toEqual({ regNo: 'B4-7079', regNoKey: 'B47079' });
    expect(normaliseRegNo('B4 - 7079').regNo).toBe('B4-7079');
    expect(normaliseRegNo('b4 7079').regNoKey).toBe('B47079');
    expect(normaliseRegNo('N/A')).toEqual({ regNo: null, regNoKey: null });
    expect(regNoShape('B4-7079')).toBe('A9-9999');
  });
  it('validates ATC codes at every level', () => {
    expect(parseAtc('p01bf01').codes).toEqual(['P01BF01']);
    expect(parseAtc('P01BF01, N02BE01').codes).toEqual(['P01BF01', 'N02BE01']);
    expect(parseAtc('P01B').codes).toEqual(['P01B']);
    expect(parseAtc('ZZ99')).toEqual({ codes: [], invalid: ['ZZ99'] });
    expect(parseAtc('P01BF0').invalid).toEqual(['P01BF0']);
  });
  it('maps statuses and flags ones it does not know', () => {
    expect(normaliseStatus('Active').statusNorm).toBe('active');
    expect(normaliseStatus('ACTIVE ').statusNorm).toBe('active');
    expect(normaliseStatus('Inactive').statusNorm).toBe('inactive');
    expect(normaliseStatus('De-registered').statusNorm).toBe('withdrawn');
    expect(normaliseStatus('Under Review')).toEqual({ status: 'Under Review', statusNorm: 'unknown', unmapped: true });
    expect(normaliseStatus(null).unmapped).toBe(false);
  });
  it('normalises dosage forms and organisation names', () => {
    expect(normaliseDosageForm('Tablets, Film-coated')).toBe('tablet film coated');
    expect(normaliseOrg('Ajanta Pharma Nigeria Limited')).toBe('ajanta pharma');
    expect(normaliseOrg('AJANTA PHARMA LTD.')).toBe('ajanta pharma');
    expect(normaliseOrg('Ltd')).toBe('ltd'); // never collapses to nothing
  });
});

describe('sanitiseFields', () => {
  it('drops contact fields and volatile keys, and redacts emails in free text', () => {
    const { cleaned, strippedContact } = sanitiseFields({
      productName: 'X', applicantEmail: 'a@b.com', Phone: '080', 'Contact Person': 'Ada',
      fetchedAt: '2026-01-01', note: 'write to ada@corp.ng please',
      manufacturer: { name: 'M', address: '12 Road' },
    });
    expect(cleaned).toEqual({ productName: 'X', note: 'write to [redacted-email] please', manufacturer: { name: 'M' } });
    expect(strippedContact).toBe(5);
  });
});

describe('normaliseRecord', () => {
  it('maps Apify-style fields', () => {
    const n = normaliseRecord({
      sourceId: '12464',
      fields: {
        registrationNumber: 'B4-7079', productName: 'AFLOTIN 80/480 TABLETS', status: 'Active',
        manufacturer: { id: 364, name: 'Ajanta Pharma Limited', country: 'INDIA' },
        applicant: { id: 578, name: 'Ajanta Pharma Nigeria Limited' },
        activeIngredients: ['Artemether', 'Lumefantrine'], dosageForm: 'Tablet', strength: '80mg; 480mg',
        atcCode: 'P01BF01', approvedAt: '2026-08-26', expiresAt: '2031-08-25',
      },
    });
    expect(n).toMatchObject({
      regNo: 'B4-7079', regNoKey: 'B47079', ingredients: ['artemether', 'lumefantrine'], atcCodes: ['P01BF01'],
      approvedOn: '2026-08-26', expiresOn: '2031-08-25', statusNorm: 'active', manufacturerNorm: 'ajanta pharma',
    });
    expect(n.strengths).toHaveLength(2);
    expect(n.issues).toEqual([]);
  });
  it('maps Greenbook table-header-style fields', () => {
    const n = normaliseRecord({
      sourceId: '1',
      fields: {
        'Product Name': 'X', 'Active Ingredients': 'Paracetamol', NRN: 'a4-0001', Form: 'Tablet', Strengths: '500mg',
        'Applicant Name': 'Acme Ltd', 'Approval Date': '26/08/2026', Status: 'Active',
      },
    });
    expect(n).toMatchObject({ regNo: 'A4-0001', ingredients: ['paracetamol'], approvedOn: '2026-08-26', applicant: 'Acme Ltd' });
  });
  it('records issues instead of silently fixing data', () => {
    const n = normaliseRecord({
      sourceId: '1',
      fields: { productName: 'X', approvedAt: '0000-00-00', expiresAt: '2019-01-01', status: 'Under Review', atcCode: 'ZZ99', strength: 'as directed' },
    });
    expect(n.issues).toEqual(expect.arrayContaining([
      'reg_no.missing', 'ingredients.empty', 'strength.unparsed', 'atc.invalid', 'date.approval.sentinel', 'status.unmapped',
    ]));
  });
  it('flags expiry before approval and strength/ingredient count mismatch', () => {
    const n = normaliseRecord({
      sourceId: '1',
      fields: { registrationNumber: 'A1-1', approvedAt: '2024-01-01', expiresAt: '2020-01-01', activeIngredients: ['A', 'B'], strength: '5mg' },
    });
    expect(n.issues).toEqual(expect.arrayContaining(['date.expiry_before_approval', 'strength.ingredient_count_mismatch']));
  });
  it('finds a product id by several names, and not by registration number', () => {
    expect(extractSourceId({ productId: 7 })).toBe('7');
    expect(extractSourceId({ ID: '8' })).toBe('8');
    expect(extractSourceId({ registrationNumber: 'A1-1' })).toBeNull();
  });
});
