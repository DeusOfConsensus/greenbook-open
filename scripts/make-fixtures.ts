/**
 * Generates SYNTHETIC Greenbook-shaped data for tests and demos.
 *
 * Nothing here is real NAFDAC data: brands and manufacturers are invented, registration
 * numbers start with "T" (test), and the defects are planted on purpose so the quality
 * report, differ and checker have something to find. Output is deterministic.
 *
 *   npm run fixtures        writes fixtures/synthetic/*
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Rec = Record<string, unknown> & { productId: number };

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATALOG = [
  { ing: ['Artemether', 'Lumefantrine'], str: '80mg; 480mg', short: '80/480', form: 'Tablet', atc: 'P01BF01' },
  { ing: ['Artesunate', 'Amodiaquine'], str: '100mg; 270mg', short: '100/270', form: 'Tablet', atc: 'P01BF05' },
  { ing: ['Paracetamol'], str: '500mg', short: '500', form: 'Tablet', atc: 'N02BE01' },
  { ing: ['Amoxicillin'], str: '500mg', short: '500', form: 'Capsule', atc: 'J01CA04' },
  { ing: ['Amoxicillin'], str: '250mg/5ml', short: '250/5', form: 'Suspension', atc: 'J01CA04' },
  { ing: ['Amoxicillin', 'Clavulanic Acid'], str: '500mg/125mg', short: '500/125', form: 'Tablet', atc: 'J01CR02' },
  { ing: ['Metformin Hydrochloride'], str: '500mg', short: '500', form: 'Tablet', atc: 'A10BA02' },
  { ing: ['Ibuprofen'], str: '400mg', short: '400', form: 'Tablet', atc: 'M01AE01' },
  { ing: ['Ciprofloxacin'], str: '500mg', short: '500', form: 'Tablet', atc: 'J01MA02' },
  { ing: ['Amlodipine'], str: '5mg', short: '5', form: 'Tablet', atc: 'C08CA01' },
  { ing: ['Loratadine'], str: '10mg', short: '10', form: 'Tablet', atc: 'R06AX13' },
  { ing: ['Omeprazole'], str: '20mg', short: '20', form: 'Capsule', atc: 'A02BC01' },
  { ing: ['Cabergoline'], str: '0.5mg', short: '0.5', form: 'Tablet', atc: 'G02CB03' },
  { ing: ['Azithromycin'], str: '500mg', short: '500', form: 'Tablet', atc: 'J01FA10' },
  { ing: ['Metronidazole'], str: '400mg', short: '400', form: 'Tablet', atc: 'P01AB01' },
  { ing: ['Diclofenac Sodium'], str: '50mg', short: '50', form: 'Tablet', atc: 'M01AB05' },
];

const MAKERS = [
  { id: 101, name: 'Demo Pharma Limited', country: 'INDIA', variants: ['Demo Pharma Limited', 'DEMO PHARMA LTD.', 'Demo Pharma Ltd'] },
  { id: 102, name: 'Sample Labs Nigeria Limited', country: 'NIGERIA', variants: ['Sample Labs Nigeria Limited'] },
  { id: 103, name: 'Testa Healthcare Plc', country: 'NIGERIA', variants: ['Testa Healthcare Plc', 'TESTA HEALTHCARE PLC'] },
  { id: 104, name: 'Exemplar Pharmaceuticals Ltd', country: 'CHINA', variants: ['Exemplar Pharmaceuticals Ltd', 'Exemplar Pharmaceuticals Limited'] },
  { id: 105, name: 'Placeholder Biotech GmbH', country: 'GERMANY', variants: ['Placeholder Biotech GmbH'] },
];

const SYL = ['zol', 'mar', 'ven', 'dra', 'lex', 'nor', 'pri', 'kel', 'ova', 'tan', 'ris', 'bex', 'cur', 'fen', 'gal', 'hep'];

export interface FixtureSet {
  snapshots: { name: string; takenAt: string; records: Rec[] }[];
  stock: { csv: string; expected: Record<number, { verdict: string; severity: string }> };
  planted: {
    sharedRegNumbers: number;
    productsSharingRegNumbers: number;
    idsMissingInRange: number;
    contactFieldsPerRecordSnap1: number;
  };
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDate(y: number, m: number, d: number, style: number): string {
  switch (style % 4) {
    case 1: return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    case 2: return `${d} ${MON[m - 1]} ${y}`;
    case 3: return `${MONTH_LONG[m - 1]} ${d}, ${y}`;
    default: return iso(y, m, d);
  }
}

export function buildFixtures(): FixtureSet {
  const rnd = mulberry32(20261015);
  const usedBrands = new Set<string>();
  const brand = () => {
    for (;;) {
      const b = SYL[Math.floor(rnd() * SYL.length)]! + SYL[Math.floor(rnd() * SYL.length)]! + (rnd() < 0.5 ? 'ex' : 'in');
      const name = b.toUpperCase();
      if (!usedBrands.has(name)) { usedBrands.add(name); return name; }
    }
  };

  // ---------- snapshot 1: 300 products ----------
  const BASE = 300;
  const idOf = (i: number) => 1000 + i + Math.floor(i / 7); // skips every 7th id: planted gaps
  const regOf = (i: number) => `T${1 + (i % 9)}-${String(1000 + i).padStart(4, '0')}`;

  const make = (i: number): Rec => {
    const c = CATALOG[i % CATALOG.length]!;
    const maker = MAKERS[i % MAKERS.length]!;
    const makerName = maker.variants[Math.floor(i / MAKERS.length) % maker.variants.length]!;
    const approvedY = 2021 + (i % 5);
    const approvedM = 1 + ((i * 3) % 12);
    const approvedD = 1 + ((i * 7) % 27);
    const rec: Rec = {
      productId: idOf(i),
      registrationNumber: regOf(i),
      productName: `${brand()} ${c.short} ${c.form.toUpperCase()}S`,
      category: 'Drugs',
      status: i % 12 === 5 ? 'Inactive' : 'Active',
      applicant: { id: 500 + (i % 7), name: `${maker.name.split(' ')[0]} Nigeria Limited` },
      manufacturer: { id: maker.id, name: makerName, country: maker.country },
      activeIngredients: c.ing,
      dosageForm: c.form,
      route: 'Oral',
      strength: c.str,
      packSize: '30 x 1',
      atcCode: c.atc,
      approvedAt: fmtDate(approvedY, approvedM, approvedD, i),
      expiresAt: iso(approvedY + 5, approvedM, approvedD),
    };
    if (i % 10 === 0) { // contact details that must never be stored
      rec.applicantEmail = `regulatory${i}@demo.example`;
      rec.applicantPhone = `0800000${String(i).padStart(4, '0')}`;
    }
    if (i % 19 === 0) delete rec.atcCode;
    return rec;
  };

  const s1: Rec[] = [];
  for (let i = 0; i < BASE; i++) s1.push(make(i));

  // Planted defects, each at a known index.
  s1[17]!.approvedAt = '0000-00-00';                       // placeholder date
  s1[31]!.expiresAt = '2019-01-01';                        // expiry before approval
  s1[40]!.approvedAt = 'sometime in 2024';                 // unparseable
  s1[50]!.status = 'Under Review';                         // status the normaliser does not know
  s1[51]!.status = 'ACTIVE ';                              // whitespace / case
  s1[60]!.atcCode = 'ZZ99';                                // invalid ATC
  s1[70]!.strength = 'as directed';                        // unparseable strength
  s1[80]!.strength = '500MG';
  s1[3]!.strength = '500 mg';
  // Five registration numbers shared by two products each (the Greenbook's known problem).
  for (const [a, b] of [[100, 101], [110, 111], [120, 121], [130, 131], [140, 141]] as const) {
    s1[b]!.registrationNumber = s1[a]!.registrationNumber;
  }
  const sharedReg = new Set([100, 110, 120, 130, 140].map((i) => s1[i]!.registrationNumber as string));
  // Pin the statuses and dates the checker scenarios below depend on.
  const pin = (i: number, patch: Partial<Rec>) => Object.assign(s1[i]!, patch);
  pin(100, { status: 'Active', expiresAt: '2030-06-30' });
  pin(101, { status: 'Active', expiresAt: '2030-06-30' });
  pin(200, { status: 'Active', approvedAt: '2024-03-10', expiresAt: '2029-03-09' });   // checker: ok
  pin(205, { status: 'Inactive' });                                                       // checker: inactive
  pin(210, { status: 'Active', approvedAt: '2021-01-15', expiresAt: '2026-01-14' });     // checker: expired by date
  pin(215, { status: 'Active', approvedAt: '2021-12-20', expiresAt: '2026-12-01' });     // checker: expiring soon (warn)

  // ---------- snapshot 2 (2026-10-01) ----------
  const s2: Rec[] = s1.map((r) => structuredClone(r));
  const removedS2 = [250, 251, 252];                                  // gone from the register
  const inactiveS2 = [20, 21, 22, 23, 24];                            // Active -> Inactive
  for (const i of inactiveS2) s2[i]!.status = 'Inactive';
  (s2[30]!.manufacturer as { name: string }).name = 'Exemplar Pharmaceuticals Ltd';  // manufacturer change
  (s2[30]!.manufacturer as { id: number }).id = 104;
  s2[80]!.strength = '500 mg';                                        // raw change, same meaning
  // Expiry-driven change: expires between the two later snapshot dates, status untouched.
  pin2(s2, 150, '2026-10-08');
  pin2(s2, 151, '2026-10-12');
  pin2(s2, 152, '2026-10-14');
  const newS2: Rec[] = [];
  for (let k = 0; k < 10; k++) {
    const r = make(BASE + k);
    r.approvedAt = iso(2026, 9, 5 + k);
    r.expiresAt = iso(2031, 9, 5 + k);
    r.status = 'Active';
    newS2.push(r);
  }
  const removedIds = new Set(removedS2.map(idOf));
  const s2full = [...s2.filter((r) => !removedIds.has(r.productId)), ...newS2];

  // ---------- snapshot 3 (2026-10-15) ----------
  const s3: Rec[] = s2full.map((r) => structuredClone(r));
  const byId = new Map(s3.map((r) => [r.productId, r]));
  byId.get(idOf(21))!.status = 'Active';                              // reactivated
  byId.get(idOf(22))!.status = 'Active';
  const removedS3 = idOf(260);
  const s3full = s3.filter((r) => r.productId !== removedS3);
  for (let k = 0; k < 4; k++) {
    const r = make(BASE + 10 + k);
    r.approvedAt = iso(2026, 10, 1 + k);
    r.expiresAt = iso(2031, 10, 1 + k);
    r.status = 'Active';
    s3full.push(r);
  }

  const snapshots = [
    { name: 'snapshot-2026-09-01', takenAt: '2026-09-01T06:00:00Z', records: s1 },
    { name: 'snapshot-2026-10-01', takenAt: '2026-10-01T06:00:00Z', records: s2full },
    { name: 'snapshot-2026-10-15', takenAt: '2026-10-15T06:00:00Z', records: s3full },
  ];

  // ---------- stock.csv with known answers ----------
  const R = (i: number) => s1[i]!.registrationNumber as string;
  const N = (i: number) => s1[i]!.productName as string;
  const rows: { reg: string; name: string; mfr: string; exp: { verdict: string; severity: string } }[] = [
    { reg: R(200), name: N(200), mfr: '', exp: { verdict: 'ok', severity: 'pass' } },
    { reg: R(205), name: N(205), mfr: '', exp: { verdict: 'inactive', severity: 'fail' } },
    { reg: R(210), name: N(210), mfr: '', exp: { verdict: 'expired', severity: 'fail' } },
    { reg: R(215), name: N(215), mfr: '', exp: { verdict: 'ok', severity: 'warn' } },
    { reg: 'T9-9999', name: 'Phantomex 100 Tablets', mfr: '', exp: { verdict: 'unregistered', severity: 'fail' } },
    { reg: R(200).slice(0, -1) + (R(200).endsWith('0') ? '1' : '0'), name: N(200), mfr: '', exp: { verdict: 'unregistered', severity: 'fail' } },
    { reg: R(200), name: 'Totally Different Syrup', mfr: '', exp: { verdict: 'mismatch', severity: 'fail' } },
    { reg: R(100), name: N(101), mfr: '', exp: { verdict: 'ok', severity: 'warn' } },        // shared number, name picks the second product
    { reg: R(110), name: '', mfr: '', exp: { verdict: 'ambiguous', severity: 'warn' } },     // shared number, nothing to choose with
    { reg: '', name: N(200), mfr: '', exp: { verdict: 'ok', severity: 'warn' } },            // no number, exact name
    { reg: '', name: 'Unknownia Quartz Elixir', mfr: '', exp: { verdict: 'unverifiable', severity: 'warn' } },
    { reg: R(200).toLowerCase().replace('-', ' '), name: N(200), mfr: '', exp: { verdict: 'ok', severity: 'pass' } }, // sloppy formatting of a good number
  ];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = ['NAFDAC Reg No,Product Name,Qty,Manufacturer']
    .concat(rows.map((r, i) => [r.reg, r.name, String(10 + i), r.mfr].map(esc).join(',')))
    .join('\n') + '\n';
  const expected: Record<number, { verdict: string; severity: string }> = {};
  rows.forEach((r, i) => { expected[i + 2] = r.exp; }); // spreadsheet rows: header is row 1

  void sharedReg;
  return {
    snapshots,
    stock: { csv, expected },
    planted: {
      sharedRegNumbers: 5,
      productsSharingRegNumbers: 10,
      idsMissingInRange: 0, // computed by the test from the ids themselves
      contactFieldsPerRecordSnap1: 2,
    },
  };
}

function pin2(list: Rec[], i: number, expiresAt: string) {
  const r = list[i]!;
  r.status = 'Active';
  r.expiresAt = expiresAt;
}

// CLI entry: write files.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = new URL('../fixtures/synthetic/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const f = buildFixtures();
  for (const s of f.snapshots) {
    writeFileSync(new URL(`${s.name}.json`, dir), `${JSON.stringify(s.records, null, 1)}\n`);
    process.stdout.write(`${s.name}.json  ${s.records.length} records\n`);
  }
  writeFileSync(new URL('stock.csv', dir), f.stock.csv);
  writeFileSync(new URL('stock.expected.json', dir), `${JSON.stringify(f.stock.expected, null, 1)}\n`);
  writeFileSync(
    new URL('README.md', dir),
    '# Synthetic fixtures\n\nINVENTED data for tests and demos. Not NAFDAC data. Brands and manufacturers are fictional,\nregistration numbers start with `T`, and defects are planted on purpose. Regenerate with `npm run fixtures`.\n',
  );
  process.stdout.write('stock.csv + stock.expected.json written\n');
}
