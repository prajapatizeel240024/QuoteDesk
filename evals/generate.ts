// npm run fixtures
// Writes the synthetic ERP export (data/erp/*.csv) and 15 RFQs with answer keys (evals/rfqs, evals/keys).
// Plan first, render second: every RFQ line is planned with its right answer, then rendered into a real
// .xlsx, .pdf or email body. Expected prices, dates and flags come from the small reference functions at the
// bottom of this file, written separately from src/server/pricing so each checks the other.
// Synthetic data only: fictional companies, .example domains, 555-01xx numbers, made-up part numbers.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { loadConfig } from '@/lib/config';
import type { Cert, Part, Supplier, Tier, Uom } from '@/lib/types';
import { toCsv } from '@/server/erp/catalog';

const cfg = loadConfig();
const P = cfg.pricing;
const HOLIDAYS = cfg.distributor.holidays;

// ---------------------------------------------------------------- the ERP export

const SUPPLIERS: Supplier[] = [
  { id: 'S-TAL', name: 'Tallis Fastener Co.', email: 'orders@tallis-fastener.example', phone: '+1-216-555-0131', default_lead_days: 8 },
  { id: 'S-ORB', name: 'Orbit Motion Components', email: 'po@orbit-motion.example', phone: '+1-614-555-0144', default_lead_days: 12 },
  { id: 'S-KEL', name: 'Keel Fluid Power', email: 'purchasing@keel-fluid.example', phone: '+1-419-555-0152', default_lead_days: 10 },
  { id: 'S-VAN', name: 'Vantor Electric Supply', email: 'orders@vantor-electric.example', phone: '+1-330-555-0166', default_lead_days: 15 },
];
const MFR: Record<string, string> = { 'S-TAL': 'Tallis Fastener Co.', 'S-ORB': 'Orbit Motion Components', 'S-KEL': 'Keel Fluid Power', 'S-VAN': 'Vantor Electric Supply' };

type Row = Omit<Part, 'mfr' | 'supplier_part' | 'stock_qty' | 'lead_time_days'> & { stock_qty?: number; lead_time_days?: number };
const rows: Row[] = [];
const add = (r: Omit<Row, 'supplier_moq' | 'status' | 'superseded_by' | 'export_controlled' | 'aliases'> & Partial<Row>) =>
  rows.push({ supplier_moq: r.pack_qty, status: 'active', superseded_by: null, export_controlled: false, aliases: [], ...r });

// Fasteners
const SIZES = [{ d: '1/4-20', c: '25', base: 6, pack: 100 }, { d: '3/8-16', c: '38', base: 13, pack: 100 }, { d: '1/2-13', c: '50', base: 27, pack: 50 }];
const LENGTHS = [{ l: '1', c: '10', f: 100 }, { l: '1-1/2', c: '15', f: 125 }, { l: '2', c: '20', f: 150 }];
const GRADES = [{ g: 'Grade 5, zinc plated', c: 'G5Z', f: 100, certs: ['CoC', 'RoHS'] as Cert[] }, { g: 'Grade 8, yellow zinc', c: 'G8Y', f: 170, certs: ['CoC', 'MTR', 'RoHS'] as Cert[] }];
SIZES.forEach((s, si) => LENGTHS.forEach((l, li) => GRADES.forEach((g, gi) => add({
  sku: `AF-${10101 + si * 6 + li * 2 + gi}`, category: 'fasteners', description: `Hex cap screw, ${s.d} x ${l.l} in, ${g.g}`,
  mfr_part: `TF-HC${s.c}${l.c}-${g.c}`, supplier_id: 'S-TAL', uom: 'EA', pack_qty: s.pack, cost_cents: Math.ceil((s.base * l.f * g.f) / 10_000), certs: g.certs,
}))));
add({ sku: 'AF-10190', category: 'fasteners', description: 'Hex cap screw, 3/8-16 x 1-1/2 in, Grade 5, cadmium plated', mfr_part: 'TF-HC3815-G5C', supplier_id: 'S-TAL', uom: 'EA', pack_qty: 100, cost_cents: 14, certs: ['CoC'], status: 'obsolete', superseded_by: 'AF-10109', stock_qty: 0 });
const NUT_BASE = [2, 4, 9];
SIZES.forEach((s, si) => GRADES.forEach((g, gi) => add({
  sku: `AF-${10201 + si * 2 + gi}`, category: 'fasteners', description: `Hex nut, ${s.d}, ${g.g}`, mfr_part: `TF-HN${s.c}-${g.c}`, supplier_id: 'S-TAL',
  uom: 'EA', pack_qty: 100, cost_cents: Math.ceil((NUT_BASE[si] * g.f) / 100), certs: g.certs,
})));
[['1/4', '25', 2], ['3/8', '38', 3], ['1/2', '50', 5]].forEach(([d, c, cost], i) => add({
  sku: `AF-${10301 + i}`, category: 'fasteners', description: `Flat washer, ${d} USS, zinc plated`, mfr_part: `TF-FW${c}-ZN`, supplier_id: 'S-TAL', uom: 'EA', pack_qty: 100, cost_cents: Number(cost), certs: ['CoC', 'RoHS'],
}));
[['M6 x 20', 'TF-SH0620-BO', 16], ['M8 x 25', 'TF-SH0825-BO', 26], ['M10 x 30', 'TF-SH1030-BO', 47]].forEach(([d, mpn, cost], i) => add({
  sku: `AF-${10401 + i}`, category: 'fasteners', description: `Socket head cap screw, ${d} mm, class 12.9, black oxide`, mfr_part: String(mpn), supplier_id: 'S-TAL', uom: 'EA', pack_qty: 50, cost_cents: Number(cost), certs: ['CoC', 'MTR'],
}));

// Power transmission
const SEALS = [{ s: '2RS', d: 'rubber sealed both sides' }, { s: 'ZZ', d: 'metal shielded both sides' }];
[['6203', 17, 310, 285], ['6204', 20, 365, 340], ['6205', 25, 440, 410]].forEach(([size, bore, c1, c2], i) => SEALS.forEach((seal, j) => add({
  sku: `AF-${20101 + i * 2 + j}`, category: 'bearings', description: `Deep groove ball bearing, ${size}-${seal.s}, ${bore} mm bore, ${seal.d}`, mfr_part: `OM-${size}-${seal.s}`,
  supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: Number(j === 0 ? c1 : c2), certs: ['CoC'], aliases: [String(size)],
})));
add({ sku: 'AF-20201', category: 'bearings', description: 'Pillow block bearing, 1 in bore, cast iron housing', mfr_part: 'OM-PB-100', supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: 1650, certs: ['CoC'] });
add({ sku: 'AF-20202', category: 'bearings', description: 'Pillow block bearing, 1-1/4 in bore, cast iron housing', mfr_part: 'OM-PB-125', supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: 2240, certs: ['CoC'] });
[['A section, 42 in', 'OM-VB-A42', 690], ['A section, 48 in', 'OM-VB-A48', 760], ['B section, 55 in', 'OM-VB-B55', 1120]].forEach(([d, mpn, cost], i) => add({
  sku: `AF-${20301 + i}`, category: 'belts', description: `V-belt, ${d}`, mfr_part: String(mpn), supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: Number(cost), certs: ['CoC'],
}));
add({ sku: 'AF-20401', category: 'chain', description: 'Roller chain, #40, riveted, 10 ft box', mfr_part: 'OM-RC40-10', supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: 3150, certs: ['CoC'] });
add({ sku: 'AF-20402', category: 'chain', description: 'Roller chain, #50, riveted, 10 ft box', mfr_part: 'OM-RC50-10', supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: 4980, certs: ['CoC'] });
add({ sku: 'AF-20501', category: 'motors', description: 'Gear motor, 1/2 HP, 60 RPM, right angle, 115/230 V', mfr_part: 'OM-GM-0560-RA', supplier_id: 'S-ORB', uom: 'EA', pack_qty: 1, cost_cents: 41_200, certs: ['CoC'], lead_time_days: 25 });

// Fluid power
[['-6 JIC male x 3/8 NPT male', 'KF-JM-0606', 210], ['-8 JIC male x 1/2 NPT male', 'KF-JM-0808', 290], ['-8 JIC male x 3/4 NPT male', 'KF-JM-0812', 380]].forEach(([d, mpn, cost], i) => add({
  sku: `AF-${30101 + i}`, category: 'fittings', description: `Hydraulic adapter, ${d}, steel`, mfr_part: String(mpn), supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: Number(cost), certs: ['CoC', 'RoHS'],
}));
add({ sku: 'AF-30201', category: 'hose', description: 'Hydraulic hose, 3/8 in ID, 2-wire braid', mfr_part: 'KF-H2W-06', supplier_id: 'S-KEL', uom: 'FT', pack_qty: 1, supplier_moq: 50, cost_cents: 285, certs: ['CoC'] });
add({ sku: 'AF-30202', category: 'hose', description: 'Hydraulic hose, 1/2 in ID, 2-wire braid', mfr_part: 'KF-H2W-08', supplier_id: 'S-KEL', uom: 'FT', pack_qty: 1, supplier_moq: 50, cost_cents: 365, certs: ['CoC'] });
[['-214, Buna-N 70A', 'KF-OR-N70-214', 4], ['-216, Buna-N 70A', 'KF-OR-N70-216', 5], ['-222, Buna-N 70A', 'KF-OR-N70-222', 6], ['-214, FKM 75A', 'KF-OR-V75-214', 22]].forEach(([d, mpn, cost], i) => add({
  sku: `AF-${30301 + i}`, category: 'o-rings', description: `O-ring, ${d}`, mfr_part: String(mpn), supplier_id: 'S-KEL', uom: 'EA', pack_qty: 100, cost_cents: Number(cost), certs: ['CoC', 'RoHS', 'REACH'],
}));
add({ sku: 'AF-30401', category: 'valves', description: 'Ball valve, 1/2 in NPT, brass, full port', mfr_part: 'KF-BV-B050', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 1180, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-30402', category: 'valves', description: 'Ball valve, 3/4 in NPT, brass, full port', mfr_part: 'KF-BV-B075', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 1640, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-30403', category: 'valves', description: 'Ball valve, 1 in NPT, 316 stainless, full port', mfr_part: 'KF-BV-S100', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 4870, certs: ['CoC', 'MTR'] });
add({ sku: 'AF-30501', category: 'pneumatics', description: 'Air cylinder, 1-1/2 in bore x 4 in stroke, double acting', mfr_part: 'KF-PC-150-400', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 6420, certs: ['CoC'] });
add({ sku: 'AF-30502', category: 'pneumatics', description: 'Air cylinder, 2 in bore x 6 in stroke, double acting', mfr_part: 'KF-PC-200-600', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 8930, certs: ['CoC'] });
add({ sku: 'AF-30601', category: 'pneumatics', description: 'Solenoid valve, 5/2, 1/4 NPT, 24 VDC coil', mfr_part: 'KF-SV52-025-24D', supplier_id: 'S-KEL', uom: 'EA', pack_qty: 1, cost_cents: 5480, certs: ['CoC', 'RoHS'] });

// Electrical
[['M12, 4 mm range, PNP NO, 2 m cable', 'VE-PX12-4P', 1890], ['M12, 4 mm range, PNP NO, M12 connector', 'VE-PX12-4P-C', 2140], ['M18, 8 mm range, PNP NO, 2 m cable', 'VE-PX18-8P', 2360]].forEach(([d, mpn, cost], i) => add({
  sku: `AF-${40101 + i}`, category: 'sensors', description: `Inductive proximity sensor, ${d}`, mfr_part: String(mpn), supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: Number(cost), certs: ['CoC', 'RoHS', 'REACH'],
}));
add({ sku: 'AF-40190', category: 'sensors', description: 'Inductive proximity sensor, M12, 4 mm range, PNP NO, 2 m cable, old housing', mfr_part: 'VE-PX12-4P-L', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: 1750, certs: ['CoC'], status: 'obsolete', superseded_by: 'AF-40101', stock_qty: 0 });
add({ sku: 'AF-40201', category: 'terminals', description: 'DIN rail terminal block, 4 mm2, gray', mfr_part: 'VE-TB4-GY', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 50, cost_cents: 58, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40202', category: 'terminals', description: 'DIN rail terminal block, 4 mm2, blue', mfr_part: 'VE-TB4-BU', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 50, cost_cents: 58, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40203', category: 'terminals', description: 'DIN rail ground terminal block, 4 mm2, green-yellow', mfr_part: 'VE-TB4-PE', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 25, cost_cents: 214, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40301', category: 'glands', description: 'Cable gland, M20, nylon, IP68', mfr_part: 'VE-CG-M20-NY', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 25, cost_cents: 61, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40302', category: 'glands', description: 'Cable gland, M25, nylon, IP68', mfr_part: 'VE-CG-M25-NY', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 25, cost_cents: 88, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40401', category: 'relays', description: 'Plug-in relay, 24 VDC coil, DPDT, 8-pin', mfr_part: 'VE-RL-24D-DP', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: 760, certs: ['CoC', 'RoHS'] });
add({ sku: 'AF-40402', category: 'relays', description: 'Relay socket, 8-pin, DIN rail mount', mfr_part: 'VE-RS-8P', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: 410, certs: ['CoC', 'RoHS'] });
// Synthetic export flag on two ordinary catalog items, so the hold path can be shown. Not real classifications.
add({ sku: 'AF-40501', category: 'motion', description: 'Precision motion controller, 8-axis', mfr_part: 'VE-MC-8X', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: 185_000, certs: ['CoC'], export_controlled: true, lead_time_days: 30 });
add({ sku: 'AF-40502', category: 'motion', description: 'Absolute rotary encoder, 25-bit', mfr_part: 'VE-ENC-25B', supplier_id: 'S-VAN', uom: 'EA', pack_qty: 1, cost_cents: 64_000, certs: ['CoC'], export_controlled: true, lead_time_days: 30 });

// Stock levels the RFQs depend on; everything else gets a plain default.
const STOCK: Record<string, number> = {
  'AF-10117': 380, 'AF-10205': 2400, 'AF-10303': 1500, 'AF-30301': 4000, 'AF-40101': 40, 'AF-10107': 1200, 'AF-10203': 3000, 'AF-10302': 900, 'AF-10109': 800,
  'AF-20302': 15, 'AF-30601': 9, 'AF-20103': 60, 'AF-20104': 35, 'AF-30102': 120, 'AF-30401': 30, 'AF-30501': 8, 'AF-30403': 20, 'AF-30304': 900,
  'AF-30201': 600, 'AF-40301': 500, 'AF-40401': 140, 'AF-40201': 5000, 'AF-30302': 8000, 'AF-10402': 3000, 'AF-40203': 150, 'AF-40102': 50,
  'AF-40501': 2, 'AF-40502': 6, 'AF-20401': 2, 'AF-20501': 1, 'AF-20303': 25, 'AF-30101': 80, 'AF-20201': 12, 'AF-20301': 40, 'AF-40103': 18,
  'AF-40402': 90, 'AF-10108': 2000, 'AF-20105': 30, 'AF-30303': 3000, 'AF-10403': 500, 'AF-30502': 5, 'AF-30402': 24, 'AF-20102': 40, 'AF-30202': 250,
  'AF-40202': 1500, 'AF-20402': 5, 'AF-10102': 1000,
};
const ALIASES: Record<string, string[]> = { 'AF-10117': ['HCS-1/2X2-G5'], 'AF-30401': ['BV-050-BR'] };

const parts: Part[] = rows.map((r, n) => {
  const supplier = SUPPLIERS.find((s) => s.id === r.supplier_id)!;
  const stock = r.stock_qty ?? STOCK[r.sku] ?? (r.category === 'fasteners' ? 600 + (n % 7) * 250 : 10 + (n % 9) * 5);
  return { ...r, aliases: [...r.aliases, ...(ALIASES[r.sku] ?? [])], mfr: MFR[r.supplier_id], supplier_part: r.mfr_part, stock_qty: stock, lead_time_days: r.lead_time_days ?? supplier.default_lead_days };
});
const byMpn = new Map(parts.map((p) => [p.mfr_part, p]));
const bySku = new Map(parts.map((p) => [p.sku, p]));
const sku = (mpn: string) => {
  const p = byMpn.get(mpn);
  if (!p) throw new Error(`No catalog part with manufacturer number ${mpn}`);
  return p.sku;
};

const XREF: [string, string, string][] = [
  ['C-1001', 'HPV-100233', 'TF-HC5020-G5Z'], ['C-1001', 'HPV-100241', 'TF-HN50-G5Z'], ['C-1001', 'HPV-100250', 'TF-FW50-ZN'], ['C-1001', 'HPV-200118', 'KF-OR-N70-214'],
  ['C-1001', 'HPV-200130', 'KF-JM-0808'], ['C-1001', 'HPV-300412', 'VE-PX12-4P'], ['C-1001', 'HPV-400007', 'OM-6205-2RS'],
  ['C-1005', 'SPS-7781', 'VE-TB4-GY'], ['C-1005', 'SPS-7782', 'VE-TB4-PE'], ['C-1005', 'SPS-5140', 'KF-OR-N70-216'], ['C-1005', 'SPS-9003', 'VE-RL-24D-DP'],
];

// ---------------------------------------------------------------- the RFQ plans

type Kind = 'xlsx-harbor' | 'xlsx-summit' | 'xlsx-bayfront' | 'pdf-table' | 'pdf-list' | 'body';
interface Spec {
  mpn: string | null; // the right catalog part (null: not something we carry)
  part_text?: string;
  desc?: string;
  qty_text: string;
  qty: number | null;
  uom_text?: string;
  uom?: Uom;
  due_text?: string; // text as written; spreadsheet date cells are written as real dates and read back as YYYY-MM-DD
  due?: string | null; // expected need-by date; undefined means "the email's default"
  certs_text?: string;
  certs?: Cert[];
  certs_unclear?: boolean;
  export_text?: string;
  export?: 'marked' | 'screened' | 'catalog';
  review?: boolean; // a careful matcher should ask a person
  quote?: string; // free-text lines: the exact span
  extract_by?: 'rule' | 'claude';
  where?: 'body'; // an extra item written in the email body of an RFQ that also has an attachment
  traps: string[];
}
interface Plan {
  id: string;
  split: 'dev' | 'holdout';
  customer: string;
  from: { name: string; email: string };
  received: string; // ISO, UTC
  subject: string;
  body: string;
  kind: Kind;
  filename?: string;
  doc_ref?: string; // RFQ number printed on the attachment
  defaults?: { due?: string; certs?: Cert[]; quote: string };
  lines: Spec[];
  rfq_traps?: string[];
}

const sig = {
  priya: 'Priya Raman\nPurchasing, Harbor Pump & Valve Co.\n+1-216-555-0161',
  tom: 'Tom Kowalski | Purchasing | Cedar Ridge Fabrication\n+1-330-555-0117',
  sam: 'Sam Achebe\nBayfront Marine Works',
  lena: 'Lena Fischer\nSummit Packaging Systems',
  jo: 'Jo Park\nTern Robotics Lab',
};
const PRIYA = { name: 'Priya Raman', email: 'praman@harborpump.example' };
const TOM = { name: 'Tom Kowalski', email: 'tkowalski@cedarridgefab.example' };
const SAM = { name: 'Sam Achebe', email: 'sachebe@bayfront-marine.example' };
const LENA = { name: 'Lena Fischer', email: 'lfischer@summitpack.example' };
const JO = { name: 'Jo Park', email: 'jpark@ternrobotics.example' };

const PLANS: Plan[] = [
  {
    id: 'rfq-01', split: 'dev', customer: 'C-1001', from: PRIYA, received: '2026-10-05T13:12:00Z', kind: 'xlsx-harbor', filename: 'HPV-RFQ-4466.xlsx', doc_ref: '4466',
    subject: 'RFQ 4466 - fastener and sensor restock',
    body: `Hi Maya,\n\nPlease quote the attached RFQ 4466. Pricing and lead time by Wednesday if you can.\n\nThanks,\n${sig.priya}`,
    lines: [
      { mpn: 'TF-HN50-G5Z', part_text: 'HPV-100241', desc: 'Hex nut 1/2-13 gr5 zinc', qty_text: '400', qty: 400, uom_text: 'EA', due_text: '2026-10-16', due: '2026-10-16', certs_text: 'CoC', certs: ['CoC'], traps: ['customer_pn', 'auto_approve'] },
      { mpn: 'TF-FW50-ZN', part_text: 'HPV-100250', desc: 'Flat washer 1/2 USS zinc', qty_text: '400', qty: 400, uom_text: 'EA', due_text: '2026-10-16', due: '2026-10-16', certs_text: 'CoC', certs: ['CoC'], traps: ['customer_pn'] },
      { mpn: 'KF-OR-N70-214', part_text: 'HPV-200118', desc: 'O-ring 214 nitrile', qty_text: '300', qty: 300, uom_text: 'EA', due_text: '2026-10-16', due: '2026-10-16', certs_text: 'CoC', certs: ['CoC'], traps: ['customer_pn'] },
      { mpn: 'TF-HC5020-G5Z', part_text: 'TF-HC5020-G5Z', desc: 'Hex cap screw 1/2-13 x 2 G5 ZP', qty_text: '200', qty: 200, uom_text: 'EA', due_text: '2026-10-16', due: '2026-10-16', certs_text: 'CoC', certs: ['CoC'], traps: ['mpn_exact'] },
      { mpn: 'VE-PX12-4P', part_text: 'HPV-300412', desc: 'Prox sensor M12 PNP', qty_text: '6', qty: 6, uom_text: 'EA', due_text: '2026-10-16', due: '2026-10-16', certs_text: 'CoC', certs: ['CoC'], traps: ['customer_pn', 'auto_approve'] },
    ],
  },
  {
    id: 'rfq-02', split: 'dev', customer: 'C-1002', from: TOM, received: '2026-10-05T15:40:00Z', kind: 'pdf-table', filename: 'CR-RQ-2291.pdf', doc_ref: 'RQ-2291',
    subject: 'Request for quote RQ-2291',
    body: `Maya,\n\nRQ-2291 is attached. Please quote your best lead time.\n\n${sig.tom}`,
    lines: [
      { mpn: 'TF-HC3810-G5Z', part_text: 'tf-hc3810-g5z', desc: 'HEX CAP SCREW 3/8-16 X 1 GR5', qty_text: '500', qty: 500, uom_text: 'EA', due_text: '10/20/2026', due: '2026-10-20', traps: ['mpn_lowercase'] },
      { mpn: 'TF-HN38-G5Z', part_text: 'TF HN38 G5Z', desc: 'HEX NUT 3/8-16 GR5', qty_text: '500', qty: 500, uom_text: 'EA', due_text: '10/20/2026', due: '2026-10-20', traps: ['mpn_spaces'] },
      { mpn: 'TF-FW38-ZN', part_text: 'TF-FW38-ZN', desc: 'FLAT WASHER 3/8 USS', qty_text: '250', qty: 250, uom_text: 'EA', due_text: '10/20/2026', due: '2026-10-20', traps: ['pack_rounded'] },
      { mpn: 'TF-HC3815-G5C', part_text: 'TF-HC3815-G5C', desc: 'HEX CAP SCREW 3/8-16 X 1-1/2 CAD', qty_text: '200', qty: 200, uom_text: 'EA', due_text: '10/20/2026', due: '2026-10-20', traps: ['obsolete_substituted'] },
      { mpn: 'OM-VB-A48', part_text: 'OM\u2013VB\u2013A48', desc: 'V-BELT A48', qty_text: '4', qty: 4, uom_text: 'EA', due_text: '', due: null, traps: ['unicode_dash', 'missing_due'] },
      { mpn: 'KF-SV52-025-24D', part_text: 'KF-SV52-025-24D', desc: 'SOLENOID VALVE 5/2 24VDC', qty_text: '2', qty: 2, uom_text: 'EA', due_text: '10/20/2026', due: '2026-10-20', traps: ['mpn_exact'] },
    ],
  },
  {
    id: 'rfq-03', split: 'dev', customer: 'C-1001', from: PRIYA, received: '2026-10-06T13:42:00Z', kind: 'xlsx-harbor', filename: 'HPV-RFQ-4471.xlsx', doc_ref: '4471',
    subject: 'RFQ 4471 - pump rebuild kits',
    body: `Hi Maya,\n\nRFQ 4471 is attached for the pump rebuild kits. Need everything by Oct 20 please.\n\nCan you also add 2 of the 1-1/2" bore x 4" stroke air cylinders, double acting? Same date.\n\nThanks,\n${sig.priya}`,
    defaults: { due: '2026-10-20', quote: 'Need everything by Oct 20' },
    lines: [
      { mpn: 'TF-HC5020-G5Z', part_text: 'HPV-100233', desc: 'Hex cap screw 1/2-13 x 2 gr5 zinc', qty_text: '500', qty: 500, uom_text: 'EA', certs_text: 'C of C', certs: ['CoC'], traps: ['customer_pn', 'email_default_due', 'lead_time_miss', 'stock_short'] },
      { mpn: 'OM-6204-2RS', part_text: '6204', desc: 'Ball bearing, conveyor idler', qty_text: '24', qty: 24, uom_text: 'EA', review: true, traps: ['ambiguous_alias'] },
      { mpn: 'KF-JM-0808', part_text: 'KF-JM-0808', desc: 'JIC adapter -8 x 1/2 NPT', qty_text: 'TBD', qty: null, uom_text: 'EA', traps: ['missing_qty'] },
      { mpn: 'TF-HN50-G5Z', part_text: 'HPV-100241', desc: 'Hex nut 1/2-13 gr5 zinc', qty_text: '1000', qty: 1000, uom_text: 'EA', certs_text: 'CoC', certs: ['CoC'], traps: ['customer_pn', 'qty_break', 'auto_approve'] },
      { mpn: 'VE-PX12-4P-L', part_text: 'VE-PX12-4P-L', desc: 'Prox sensor M12 4mm PNP cable', qty_text: '6', qty: 6, uom_text: 'EA', certs_text: 'CoC', certs: ['CoC'], traps: ['obsolete_ask'] },
      { mpn: 'KF-BV-B050', part_text: '', desc: '1/2 in brass ball valve, NPT, full port', qty_text: '10', qty: 10, uom_text: 'EA', traps: ['description_only'] },
      { mpn: 'KF-PC-150-400', where: 'body', extract_by: 'claude', quote: '2 of the 1-1/2" bore x 4" stroke air cylinders, double acting', desc: '1-1/2" bore x 4" stroke air cylinders, double acting', qty_text: '2', qty: 2, traps: ['email_item', 'description_only'] },
    ],
  },
  {
    id: 'rfq-04', split: 'dev', customer: 'C-1003', from: { name: 'Dee Hollis', email: 'dee.hollis@mailbox.example' }, received: '2026-10-06T18:05:00Z', kind: 'body',
    subject: 'parts quote',
    body: 'Hi Maya,\n\nCould you price out 40 of the 1/2-13 x 2 grade 5 hex bolts, a box of 3/8 hex nuts, and 2 more of the M12 prox sensors, the 4mm PNP ones with the cable. Need them by Friday the 16th if possible.\n\nThanks!\nDee Hollis\nLarkspur Ag Machines',
    defaults: { due: '2026-10-16', quote: 'Need them by Friday the 16th' },
    rfq_traps: ['personal_mailbox'],
    lines: [
      { mpn: 'TF-HC5020-G5Z', extract_by: 'claude', quote: '40 of the 1/2-13 x 2 grade 5 hex bolts', desc: '1/2-13 x 2 grade 5 hex bolts', qty_text: '40', qty: 40, traps: ['prose', 'description_only', 'pack_rounded'] },
      { mpn: 'TF-HN38-G5Z', extract_by: 'claude', quote: 'a box of 3/8 hex nuts', desc: '3/8 hex nuts', qty_text: 'a box', qty: 1, uom: 'PK', review: true, traps: ['prose', 'ambiguous_grade', 'uom_pack'] },
      { mpn: 'VE-PX12-4P', extract_by: 'claude', quote: '2 more of the M12 prox sensors, the 4mm PNP ones with the cable', desc: 'M12 prox sensors, the 4mm PNP ones with the cable', qty_text: '2', qty: 2, traps: ['prose', 'description_only'] },
    ],
  },
  {
    id: 'rfq-05', split: 'dev', customer: 'C-1004', from: SAM, received: '2026-10-07T14:20:00Z', kind: 'xlsx-bayfront', filename: 'BMW-Quote-Request-1007.xlsx',
    subject: 'Quote request - hull pump refit',
    body: `Sam here. Quote request attached. A couple of these are needed this week.\n\n${sig.sam}`,
    lines: [
      { mpn: 'KF-BV-S100', part_text: 'KF-BV-S100', desc: 'Ball valve 1in NPT 316SS', qty_text: '12', qty: 12, uom_text: 'ea', due_text: '10/23/26', due: '2026-10-23', certs_text: 'MTR', certs: ['MTR'], traps: ['text_date'] },
      { mpn: 'KF-OR-V75-214', part_text: 'KF-OR-V75-214', desc: 'O-ring -214 Viton', qty_text: '250', qty: 250, uom_text: 'ea', due_text: '10/23/26', due: '2026-10-23', certs_text: 'RoHS, REACH', certs: ['RoHS', 'REACH'], traps: ['pack_rounded'] },
      { mpn: 'KF-H2W-06', part_text: 'KF-H2W-06', desc: 'Hyd hose 3/8 2-wire', qty_text: '150', qty: 150, uom_text: 'ft', uom: 'FT', due_text: '10/23/26', due: '2026-10-23', certs_text: 'MTR', certs: ['MTR'], traps: ['cert_unavailable'] },
      { mpn: 'VE-CG-M20-NY', part_text: 'VE-CG-M20-NY', desc: 'Cable gland M20', qty_text: '100', qty: 100, uom_text: 'ea', due_text: '10/23/26', due: '2026-10-23', traps: ['mpn_exact'] },
      { mpn: 'VE-RL-24D-DP', part_text: 'VE-RL-24D-DP', desc: 'Relay 24VDC DPDT', qty_text: '30', qty: 30, uom_text: 'ea', due_text: '10/09/26', due: '2026-10-09', certs_text: 'Yes', certs_unclear: true, traps: ['rush_fee', 'unclear_certs'] },
    ],
  },
  {
    id: 'rfq-06', split: 'dev', customer: 'C-1005', from: LENA, received: '2026-10-07T19:55:00Z', kind: 'xlsx-summit', filename: 'SPS-RFQ-20261007.xlsx',
    subject: 'RFQ - line 4 maintenance stock',
    body: `Hello Maya,\n\nAttached is our RFQ for line 4 maintenance stock. Please note the export control column.\n\nBest regards,\n${sig.lena}`,
    lines: [
      { mpn: 'VE-TB4-GY', part_text: 'SPS-7781', desc: 'Terminal block 4mm2 gray', qty_text: '2,000', qty: 2000, due_text: '2026-10-23', due: '2026-10-23', traps: ['customer_pn', 'qty_comma', 'qty_break', 'auto_approve'] },
      { mpn: 'KF-OR-N70-216', part_text: 'SPS-5140', desc: 'O-ring -216 NBR', qty_text: '5k', qty: 5000, due_text: '2026-10-23', due: '2026-10-23', traps: ['customer_pn', 'qty_k', 'qty_break', 'auto_approve'] },
      { mpn: 'VE-RL-24D-DP', part_text: 'SPS-9003', desc: 'Relay 24VDC DPDT', qty_text: '120', qty: 120, due_text: '2026-10-23', due: '2026-10-23', traps: ['customer_pn', 'qty_break'] },
      { mpn: 'TF-SH0825-BO', part_text: 'TF-SH0825-BO', desc: 'SHCS M8x25 12.9', qty_text: '1k', qty: 1000, due_text: '2026-10-23', due: '2026-10-23', traps: ['qty_k', 'qty_break', 'auto_approve'] },
      { mpn: 'KF-SV52-025-24D', part_text: 'KF-SV52-025-24D', desc: 'Solenoid valve 5/2 24VDC', qty_text: '4', qty: 4, due_text: '2026-10-23', due: '2026-10-23', export_text: 'Y', export: 'marked', traps: ['export_marked'] },
      { mpn: 'VE-TB4-PE', part_text: 'SPS-7782', desc: 'Ground terminal block 4mm2', qty_text: '300', qty: 300, due_text: '2026-10-23', due: '2026-10-23', traps: ['customer_pn', 'lead_time_miss', 'stock_short'] },
    ],
  },
  {
    id: 'rfq-07', split: 'dev', customer: 'C-1006', from: JO, received: '2026-10-08T13:30:00Z', kind: 'pdf-list', filename: 'Tern-quote-request.pdf',
    subject: 'Quote request for test cell build',
    body: `Hi,\n\nPlease see the attached list for our test cell build. We need pricing by the end of the week.\n\nThanks,\n${sig.jo}`,
    defaults: { due: '2026-10-30', quote: 'Need by: October 30, 2026' },
    lines: [
      { mpn: 'VE-MC-8X', quote: '1. Precision motion controller, 8-axis - qty 2', desc: 'Precision motion controller, 8-axis', qty_text: '2', qty: 2, export: 'screened', traps: ['export_screened'] },
      { mpn: 'VE-ENC-25B', quote: '2. Absolute rotary encoder, 25-bit - qty 4', desc: 'Absolute rotary encoder, 25-bit', qty_text: '4', qty: 4, export: 'screened', traps: ['export_screened'] },
      { mpn: 'VE-PX12-4P-C', quote: '3. Prox sensor M12, connector version, VE-PX12-4P-C - qty 10', part_text: 'VE-PX12-4P-C', desc: 'Prox sensor M12, connector version, VE-PX12-4P-C', qty_text: '10', qty: 10, traps: ['pdf_list', 'embedded_part_number'] },
      { mpn: 'VE-TB4-GY', quote: '4. DIN terminal blocks, gray - qty 1 pack', desc: 'DIN terminal blocks, gray', qty_text: '1 pack', qty: 1, uom: 'PK', traps: ['pdf_list', 'description_only', 'uom_pack'] },
    ],
  },
  {
    id: 'rfq-08', split: 'dev', customer: 'C-1002', from: TOM, received: '2026-10-09T12:15:00Z', kind: 'pdf-table', filename: 'CR-RQ-2304.pdf', doc_ref: 'RQ-2304',
    subject: 'RQ-2304',
    body: `Maya, RQ-2304 attached.\n\n${sig.tom}`,
    lines: [
      { mpn: 'TF-HC5020-G5Z', part_text: 'TF-HC5O20-G5Z', desc: 'HEX CAP SCREW 1/2-13 X 2 GR5 ZP', qty_text: '300', qty: 300, uom_text: 'EA', due_text: '10/30/2026', due: '2026-10-30', traps: ['typo_part_number'] },
      { mpn: 'OM-RC40-10', part_text: 'OM-RC40-10', desc: 'ROLLER CHAIN #40 10FT', qty_text: '6', qty: 6, uom_text: 'EA', due_text: '10/30/2026', due: '2026-10-30', traps: ['stock_short'] },
      { mpn: null, part_text: 'CR-BRKT-117', desc: 'WELDMENT BRACKET PER DWG 117', qty_text: '20', qty: 20, uom_text: 'EA', due_text: '10/30/2026', due: '2026-10-30', traps: ['unknown_part'] },
      { mpn: 'OM-GM-0560-RA', part_text: 'OM-GM-0560-RA', desc: 'GEAR MOTOR 1/2HP 60RPM RA', qty_text: '2', qty: 2, uom_text: 'EA', due_text: '10/16/2026', due: '2026-10-16', traps: ['lead_time_miss', 'stock_short'] },
      { mpn: 'OM-VB-B55', part_text: 'OM-VB-B55', desc: 'V-BELT B55', qty_text: '10', qty: 10, uom_text: 'EA', due_text: '10/30/2026', due: '2026-10-30', traps: ['mpn_exact'] },
    ],
  },
  {
    id: 'rfq-09', split: 'dev', customer: 'C-1003', from: { name: 'Dee Hollis', email: 'dhollis@larkspur-ag.example' }, received: '2026-10-12T17:10:00Z', kind: 'body',
    subject: 'Order quote - hydraulic repair',
    body: 'Maya,\n\nQuote please:\n- 25 ft KF-H2W-06\n- 4 x KF-JM-0606\n- 2 x KF-SV52-025-24D\n- 10 x AF-30304\n\nNeed these 2 weeks ARO.\n\nDee',
    defaults: { due: '2026-10-26', quote: '2 weeks ARO' },
    lines: [
      { mpn: 'KF-H2W-06', quote: '- 25 ft KF-H2W-06', part_text: 'KF-H2W-06', qty_text: '25', qty: 25, uom_text: 'ft', uom: 'FT', traps: ['email_bullets'] },
      { mpn: 'KF-JM-0606', quote: '- 4 x KF-JM-0606', part_text: 'KF-JM-0606', qty_text: '4', qty: 4, traps: ['email_bullets'] },
      { mpn: 'KF-SV52-025-24D', quote: '- 2 x KF-SV52-025-24D', part_text: 'KF-SV52-025-24D', qty_text: '2', qty: 2, traps: ['email_bullets'] },
      { mpn: 'KF-OR-V75-214', quote: '- 10 x AF-30304', part_text: 'AF-30304', qty_text: '10', qty: 10, traps: ['email_bullets', 'our_sku', 'pack_rounded'] },
    ],
    rfq_traps: ['aro_due'],
  },
  {
    id: 'rfq-10', split: 'dev', customer: 'C-1004', from: SAM, received: '2026-10-13T15:00:00Z', kind: 'xlsx-bayfront', filename: 'BMW-Quote-Request-1013.xlsx',
    subject: 'Quote request - deck winch service',
    body: `Hi Maya, see attached.\n\n${sig.sam}`,
    lines: [
      { mpn: 'OM-PB-100', part_text: 'OM-PB-100', desc: 'Pillow block 1in bore', qty_text: '4', qty: 4, uom_text: 'ea', due_text: '10/27/26', due: '2026-10-27', certs_text: 'MTR', certs: ['MTR'], traps: ['cert_unavailable'] },
      { mpn: 'OM-VB-A42', part_text: 'OM\u2013VB\u2013A42', desc: 'V-belt A42', qty_text: '20', qty: 20, uom_text: 'ea', due_text: '10/27/26', due: '2026-10-27', traps: ['unicode_dash'] },
      { mpn: 'KF-SV52-025-24D', part_text: 'KF-SV52-025-24D', desc: 'Solenoid valve 5/2', qty_text: '2', qty: 2, uom_text: 'ea', due_text: '10/27/26', due: '2026-10-27', traps: ['mpn_exact'] },
      { mpn: 'VE-PX18-8P', part_text: 'VE-PX18-8P', desc: 'Prox M18 8mm PNP', qty_text: '6', qty: 6, uom_text: 'ea', due_text: 'ASAP', due: null, traps: ['asap_due'] },
      { mpn: 'VE-RS-8P', part_text: 'VE-RS-8P', desc: 'Relay socket 8 pin', qty_text: '30', qty: 30, uom_text: 'ea', due_text: '10/27/26', due: '2026-10-27', traps: ['mpn_exact'] },
    ],
    rfq_traps: ['stop_rows'],
  },
  // ---------- holdout: score these once, at the end
  {
    id: 'rfq-11', split: 'holdout', customer: 'C-1001', from: PRIYA, received: '2026-10-14T14:05:00Z', kind: 'xlsx-harbor', filename: 'HPV-RFQ-4490.xlsx', doc_ref: '4490',
    subject: 'RFQ 4490',
    body: `Hi Maya,\n\nRFQ 4490 attached. Need by 10/28 on all lines.\n\nThanks,\n${sig.priya}`,
    defaults: { due: '2026-10-28', quote: 'Need by 10/28' },
    lines: [
      { mpn: 'TF-HN50-G5Z', part_text: 'HPV-10O241', desc: 'Hex nut 1/2-13 gr5 zinc', qty_text: '600', qty: 600, uom_text: 'EA', certs_text: 'CoC', certs: ['CoC'], traps: ['typo_customer_pn'] },
      { mpn: 'TF-HC3810-G8Y', part_text: '', desc: 'Hex cap screw 3/8-16 x 1 grade 8', qty_text: '1.5k', qty: 1500, uom_text: 'EA', traps: ['description_only', 'qty_k'] },
      { mpn: 'OM-6205-2RS', part_text: 'HPV-400007', desc: 'Bearing 6205 sealed', qty_text: '12', qty: 12, uom_text: 'EA', traps: ['customer_pn'] },
      { mpn: 'KF-JM-0808', part_text: 'HPV-200130', desc: 'JIC adapter -8 x 1/2 NPT', qty_text: '40', qty: 40, uom_text: 'EA', certs_text: 'MTR', certs: ['MTR'], traps: ['customer_pn', 'cert_unavailable'] },
      { mpn: 'VE-RL-24D-DP', part_text: 'VE-RL-24D-DP', desc: 'Relay 24VDC DPDT 8 pin', qty_text: '8', qty: 8, uom_text: 'EA', traps: ['mpn_exact'] },
    ],
  },
  {
    id: 'rfq-12', split: 'holdout', customer: 'C-1005', from: LENA, received: '2026-10-14T18:30:00Z', kind: 'xlsx-summit', filename: 'SPS-RFQ-20261014.xlsx',
    subject: 'RFQ - urgent line 2 parts',
    body: `Maya,\n\nA couple of these are urgent, see the dates.\n\nThanks,\n${sig.lena}`,
    lines: [
      { mpn: 'VE-ENC-25B', part_text: 'VE-ENC-25B', desc: 'Absolute encoder 25-bit', qty_text: '2', qty: 2, due_text: '2026-10-21', due: '2026-10-21', export_text: 'Y', export: 'marked', traps: ['export_marked'] },
      { mpn: 'VE-TB4-GY', part_text: 'SPS-7781', desc: 'Terminal block 4mm2 gray', qty_text: '400', qty: 400, due_text: '2026-10-16', due: '2026-10-16', traps: ['customer_pn', 'rush_fee_waived', 'auto_approve'] },
      { mpn: 'KF-OR-N70-222', part_text: 'KF-OR-N70-222', desc: 'O-ring -222 NBR', qty_text: '1,200', qty: 1200, due_text: '2026-10-21', due: '2026-10-21', traps: ['qty_comma', 'qty_break'] },
      { mpn: 'TF-SH1030-BO', part_text: 'TF-SH1030-BO', desc: 'SHCS M10x30 12.9', qty_text: '800', qty: 800, due_text: '2026-10-21', due: '2026-10-21', traps: ['lead_time_miss', 'stock_short'] },
      { mpn: 'KF-PC-200-600', part_text: 'KF-PC-200-600', desc: 'Air cylinder 2 x 6', qty_text: '3', qty: 3, due_text: '2026-10-21', due: '2026-10-21', traps: ['mpn_exact'] },
    ],
  },
  {
    id: 'rfq-13', split: 'holdout', customer: 'C-1002', from: TOM, received: '2026-10-15T13:00:00Z', kind: 'pdf-table', filename: 'CR-RQ-2311.pdf', doc_ref: 'RQ-2311',
    subject: 'RQ-2311',
    body: `Maya, please quote RQ-2311. Thanks.\n\n${sig.tom}`,
    lines: [
      { mpn: 'TF-HC3815-G5C', part_text: 'TF-HC3815-G5C', desc: 'HEX CAP SCREW 3/8-16 X 1-1/2 CAD', qty_text: '300', qty: 300, uom_text: 'EA', due_text: '11/02/2026', due: '2026-11-02', traps: ['obsolete_substituted'] },
      { mpn: null, part_text: 'CR-SPCR-044', desc: 'SPACER 1/2 ID X 3/4 OD DELRIN', qty_text: '50', qty: 50, uom_text: 'EA', due_text: '11/02/2026', due: '2026-11-02', traps: ['unknown_part'] },
      { mpn: 'KF-OR-N70-214', part_text: 'KF-OR-N70-214', desc: 'O-RING -214 BUNA', qty_text: '150', qty: 150, uom_text: 'EA', due_text: '11/02/2026', due: '2026-11-02', traps: ['pack_rounded'] },
      { mpn: 'KF-BV-B075', part_text: 'kf-bv-b075', desc: 'BALL VALVE 3/4 BRASS', qty_text: '6', qty: 6, uom_text: 'EA', due_text: '11/02/2026', due: '2026-11-02', traps: ['mpn_lowercase'] },
      { mpn: 'OM-6203-ZZ', part_text: 'OM-6203-ZZ', desc: 'BEARING 6203 ZZ', qty_text: '10', qty: 10, uom_text: 'EA', due_text: '11/02/2026', due: '2026-11-02', traps: ['mpn_exact'] },
    ],
  },
  {
    id: 'rfq-14', split: 'holdout', customer: 'C-1006', from: JO, received: '2026-10-15T20:20:00Z', kind: 'body',
    subject: 'quote for fixture build',
    body: `Hi Maya,\n\nWe're building a new test fixture and need a quote on 3 of the 8-axis motion controllers, 20 of the M12 prox sensors (connector version), and a pack of the yellow zinc 1/4-20 x 1 cap screws. Need them by Oct 30.\n\nThanks,\n${sig.jo}`,
    defaults: { due: '2026-10-30', quote: 'Need them by Oct 30' },
    lines: [
      { mpn: 'VE-MC-8X', quote: '3 of the 8-axis motion controllers', desc: '8-axis motion controllers', qty_text: '3', qty: 3, export: 'screened', traps: ['export_screened', 'prose'] },
      { mpn: 'VE-PX12-4P-C', extract_by: 'claude', quote: '20 of the M12 prox sensors (connector version)', desc: 'M12 prox sensors (connector version)', qty_text: '20', qty: 20, traps: ['prose', 'description_only'] },
      { mpn: 'TF-HC2510-G8Y', extract_by: 'claude', quote: 'a pack of the yellow zinc 1/4-20 x 1 cap screws', desc: 'yellow zinc 1/4-20 x 1 cap screws', qty_text: 'a pack', qty: 1, uom: 'PK', traps: ['prose', 'description_only', 'uom_pack'] },
    ],
  },
  {
    id: 'rfq-15', split: 'holdout', customer: 'C-1004', from: SAM, received: '2026-10-16T14:45:00Z', kind: 'xlsx-bayfront', filename: 'BMW-Quote-Request-1016.xlsx',
    subject: 'Quote request - bilge system',
    body: `Hi Maya, quote request attached. Thanks.\n\n${sig.sam}`,
    lines: [
      { mpn: 'KF-BV-B075', part_text: '', desc: 'ball vlave 3/4 brass NPT', qty_text: '6', qty: 6, uom_text: 'ea', due_text: '10/30/26', due: '2026-10-30', traps: ['description_only', 'typo_description'] },
      { mpn: 'KF-H2W-08', part_text: 'KF-H2W-08', desc: 'Hyd hose 1/2 2-wire', qty_text: '75', qty: 75, uom_text: 'ft', uom: 'FT', due_text: '10/30/26', due: '2026-10-30', certs_text: 'C of C', certs: ['CoC'], traps: ['mpn_exact'] },
      { mpn: 'VE-TB4-BU', part_text: 'VE-TB4-BU', desc: 'Terminal block blue', qty_text: '', qty: null, uom_text: 'ea', due_text: '10/30/26', due: '2026-10-30', traps: ['missing_qty'] },
      { mpn: 'KF-BV-S100', part_text: 'KF-BV-S100', desc: 'Ball valve 1in 316SS', qty_text: '4', qty: 4, uom_text: 'ea', due_text: '10/30/26', due: '2026-10-30', certs_text: 'mill certs', certs: ['MTR'], traps: ['cert_synonym'] },
      { mpn: 'OM-RC50-10', part_text: 'OM-RC50-10', desc: 'Roller chain #50 10ft', qty_text: '2', qty: 2, uom_text: 'ea', due_text: '10/20/26', due: '2026-10-20', traps: ['rush_fee'] },
    ],
  },
];

// ---------------------------------------------------------------- reference logic (independent of src/server)

function refBusinessDay(d: Date): boolean {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6 && !HOLIDAYS.includes(d.toISOString().slice(0, 10));
}
function refAddBD(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  while (!refBusinessDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  for (let k = n; k > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (refBusinessDay(d)) k--;
  }
  return d.toISOString().slice(0, 10);
}
function refCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
function refPrice(part: Part, units: number, tier: Tier, due: string | null, quote: string, waived: boolean) {
  const billed = Math.ceil(units / part.pack_qty) * part.pack_qty;
  let less = 0;
  for (const b of P.qty_breaks) if (billed >= b.min_qty) less = Math.max(less, b.less_bps);
  const margin = Math.max(P.floor_margin_bps, P.tiers[tier].margin_bps - less);
  const unit = Number(refCeil(BigInt(part.cost_cents) * 10_000n, BigInt(10_000 - margin)));
  const ext = unit * billed;
  const adj = Math.max(0, P.min_line_cents - ext);
  const inStock = part.stock_qty >= billed;
  let ship = refAddBD(quote, (inStock ? 0 : part.lead_time_days) + P.lead_time.handling_days);
  let arrive = refAddBD(ship, P.lead_time.transit_days);
  let rush = false;
  if (due && arrive > due && inStock) {
    const rs = refAddBD(quote, P.rush.handling_days);
    const ra = refAddBD(rs, P.rush.transit_days);
    if (ra <= due) [rush, ship, arrive] = [true, rs, ra];
  }
  const fee = rush && !waived ? Math.max(Number(refCeil(BigInt(ext + adj) * BigInt(P.rush.fee_bps), 10_000n)), P.rush.min_fee_cents) : 0;
  return { billed_qty: billed, margin_bps: margin, unit_cents: unit, extended_cents: ext, min_line_adjust_cents: adj, rush, rush_fee_cents: fee, line_total_cents: ext + adj + fee, in_stock: inStock, ship_date: ship, arrive_date: arrive, misses_due: Boolean(due && arrive > due), pack_rounded: billed !== units };
}

// ---------------------------------------------------------------- rendering

const OUT = path.join(process.cwd(), 'evals');
const fixed = (iso: string) => new Date(iso);
const ymd = (iso: string) => iso.slice(0, 10);
const mdY = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

async function writeXlsx(full: Plan, file: string) {
  const plan = { ...full, lines: full.lines.filter((l) => l.where !== 'body') };
  const wb = new ExcelJS.Workbook();
  wb.creator = plan.from.name;
  wb.created = fixed(plan.received);
  wb.modified = fixed(plan.received);
  const font = { name: 'Arial', size: 10 };
  const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
  if (plan.kind === 'xlsx-harbor') {
    const ws = wb.addWorksheet('RFQ');
    ws.addRow(['Harbor Pump & Valve Co.']).font = { ...font, bold: true, size: 14 };
    ws.addRow(['Request for Quote']).font = font;
    const meta = ws.addRow(['RFQ #', Number(plan.doc_ref), 'Date', date(ymd(plan.received)), 'Buyer', plan.from.name]);
    meta.getCell(4).numFmt = 'mm/dd/yyyy';
    ws.addRow([]);
    ws.addRow(['Line', 'HPV Part #', 'Description', 'Qty', 'UoM', 'Need By', "Cert Req'd"]).font = { ...font, bold: true };
    plan.lines.forEach((l, i) => {
      const r = ws.addRow([i + 1, l.part_text ?? '', l.desc ?? '', /^\d+$/.test(l.qty_text) ? Number(l.qty_text) : l.qty_text, l.uom_text ?? '', l.due_text ? date(l.due_text) : '', l.certs_text ?? '']);
      if (l.due_text) r.getCell(6).numFmt = 'mm/dd/yyyy';
    });
    ws.addRow([]);
    ws.addRow([`Notes: please reference RFQ ${plan.doc_ref} on your quote.`]);
    ws.columns = [{ width: 6 }, { width: 14 }, { width: 38 }, { width: 8 }, { width: 6 }, { width: 12 }, { width: 10 }];
  } else if (plan.kind === 'xlsx-summit') {
    const ws = wb.addWorksheet('Quote Request');
    ws.addRow(['Summit Packaging Systems - Purchasing']).font = { ...font, bold: true, size: 13 };
    const meta = ws.addRow(['RFQ date', date(ymd(plan.received))]);
    meta.getCell(2).numFmt = 'yyyy-mm-dd';
    ws.addRow([]);
    ws.addRow(['Item #', 'Mfr P/N', 'Desc.', 'Quantity', 'Required Date', 'Certifications', 'Export Ctrl']).font = { ...font, bold: true };
    plan.lines.forEach((l, i) => {
      const r = ws.addRow([i + 1, l.part_text ?? '', l.desc ?? '', /^\d+$/.test(l.qty_text) ? Number(l.qty_text) : l.qty_text, l.due_text ? date(l.due_text) : '', l.certs_text ?? '', l.export_text ?? 'N']);
      if (l.due_text) r.getCell(5).numFmt = 'yyyy-mm-dd';
    });
    ws.addRow([]);
    ws.addRow(['Total line items:', plan.lines.length]);
    ws.columns = [{ width: 7 }, { width: 16 }, { width: 30 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 11 }];
  } else {
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['P/N', 'Description', "Qty Req'd", 'U/M', 'Delivery', 'Docs Required']).font = { ...font, bold: true };
    for (const l of plan.lines) ws.addRow([l.part_text ?? '', l.desc ?? '', /^\d+$/.test(l.qty_text) ? Number(l.qty_text) : l.qty_text, l.uom_text ?? '', l.due_text ?? '', l.certs_text ?? '']);
    ws.addRow([]);
    ws.addRow(['Notes: deliver to dock 3, attention Sam.']);
    ws.addRow([`Total lines: ${plan.lines.length}`]);
    ws.columns = [{ width: 16 }, { width: 30 }, { width: 10 }, { width: 6 }, { width: 10 }, { width: 14 }];
  }
  fs.writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
}

async function writePdf(full: Plan, file: string) {
  const plan = { ...full, lines: full.lines.filter((l) => l.where !== 'body') };
  const doc = await PDFDocument.create();
  doc.setTitle(plan.subject);
  doc.setAuthor(plan.from.name);
  doc.setProducer('QuoteDesk synthetic fixtures');
  doc.setCreator(plan.kind === 'pdf-table' ? 'Cedar Ridge MRP' : 'Tern Robotics Lab');
  doc.setCreationDate(fixed(plan.received));
  doc.setModificationDate(fixed(plan.received));
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s: string, x: number, y: number, size = 9, f = font) => page.drawText(s, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  if (plan.kind === 'pdf-table') {
    text('Cedar Ridge Fabrication', 50, 742, 15, bold);
    text(`Request for Quotation ${plan.doc_ref}`, 50, 722, 12);
    text(`Date: ${mdY(plan.received)}     Buyer: Tom Kowalski     Phone: +1-330-555-0117`, 50, 704);
    const cols = [50, 82, 200, 418, 458, 500];
    ['Item', 'Part Number', 'Description', 'Qty', 'UOM', 'Due'].forEach((h, i) => text(h, cols[i], 670, 9, bold));
    page.drawLine({ start: { x: 50, y: 665 }, end: { x: 562, y: 665 }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    plan.lines.forEach((l, i) => {
      const y = 650 - i * 18;
      [String(i + 1), l.part_text ?? '', l.desc ?? '', l.qty_text, l.uom_text ?? '', l.due_text ?? ''].forEach((v, c) => {
        if (v) text(v, cols[c], y);
      });
    });
    text('Please quote best lead time. Thank you.', 50, 650 - plan.lines.length * 18 - 24);
  } else {
    text('Tern Robotics Lab', 50, 742, 15, bold);
    text('Quote request', 50, 722, 12);
    text('Date: October 8, 2026', 50, 704);
    text('Items needed:', 50, 676, 10, bold);
    plan.lines.forEach((l, i) => text(l.quote!, 62, 656 - i * 18, 10));
    text(plan.defaults!.quote, 50, 656 - plan.lines.length * 18 - 12, 10);
  }
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
}

// ---------------------------------------------------------------- keys

const TRAP_FLAGS: Record<string, string> = {
  lead_time_miss: 'LEAD_TIME_MISS', stock_short: 'STOCK_SHORT', pack_rounded: 'PACK_ROUNDED', rush_fee: 'RUSH_FEE', rush_fee_waived: 'RUSH_FEE',
  cert_unavailable: 'CERT_UNAVAILABLE', missing_qty: 'MISSING_INFO', missing_due: 'MISSING_INFO', asap_due: 'MISSING_INFO', unclear_certs: 'MISSING_INFO',
  obsolete_ask: 'OBSOLETE_PART', obsolete_substituted: 'SUBSTITUTED', unknown_part: 'UNKNOWN_PART', export_marked: 'EXPORT_CONTROLLED', export_screened: 'EXPORT_CONTROLLED',
};

function keyFor(plan: Plan) {
  const customer = cfg.customers.find((c) => c.id === plan.customer)!;
  const quoteDate = ymd(plan.received);
  const docName = plan.kind === 'body' ? 'email body' : plan.filename!;
  const docKind = plan.kind === 'body' ? 'body' : plan.kind.startsWith('xlsx') ? 'xlsx' : 'pdf';
  let tableIndex = 0;
  const lines = plan.lines.map((l, i) => {
    const asked = l.mpn ? bySku.get(sku(l.mpn))! : null;
    const substitute = asked?.status === 'obsolete' && customer.rules.substitutes === 'allow' && asked.superseded_by ? bySku.get(asked.superseded_by)! : null;
    const part = substitute ?? asked;
    const due = l.due !== undefined ? l.due : (plan.defaults?.due ?? null);
    const certs = [...new Set([...(l.certs ?? []), ...(plan.defaults?.certs ?? []), ...customer.rules.default_certs])].sort() as Cert[];
    const missing = [...(l.qty === null ? ['qty'] : []), ...(due === null ? ['due_date'] : []), ...(l.certs_unclear ? ['cert_type'] : [])];
    const exportHold = l.export ?? (part?.export_controlled ? 'catalog' : null);
    const uom: Uom = l.uom ?? 'EA';
    const units = part && l.qty !== null ? (uom === 'PK' && part.pack_qty > 1 ? l.qty * part.pack_qty : l.qty) : null;
    const priced = part && part.status === 'active' && units !== null && !exportHold;
    const price = priced ? refPrice(part, units, customer.tier, due, quoteDate, customer.rules.rush_fee_waived) : null;
    const flags: string[] = [];
    if (exportHold) flags.push('EXPORT_CONTROLLED');
    if (!exportHold && !part) flags.push('UNKNOWN_PART');
    if (!exportHold && part?.status === 'obsolete') flags.push('OBSOLETE_PART');
    if (substitute) flags.push('SUBSTITUTED');
    if (missing.length) flags.push('MISSING_INFO');
    if (!exportHold && part && certs.some((c) => !part.certs.includes(c))) flags.push('CERT_UNAVAILABLE');
    if (price) {
      if (price.pack_rounded) flags.push('PACK_ROUNDED');
      if (price.misses_due) flags.push('LEAD_TIME_MISS');
      if (!price.in_stock) flags.push('STOCK_SHORT');
      if (price.rush) flags.push('RUSH_FEE');
      if (price.min_line_adjust_cents > 0) flags.push('MIN_LINE');
    }
    for (const t of l.traps) if (TRAP_FLAGS[t] && !flags.includes(TRAP_FLAGS[t])) throw new Error(`${plan.id} line ${i + 1}: trap ${t} should raise ${TRAP_FLAGS[t]}, reference logic gives ${flags.join(', ') || 'nothing'}`);
    const isTable = (plan.kind.startsWith('xlsx') || plan.kind === 'pdf-table') && l.where !== 'body';
    const source = l.where === 'body' ? { doc: 'email body', kind: 'body', quote: l.quote! } : isTable ? { doc: docName, kind: docKind, index: tableIndex++ } : { doc: docName, kind: docKind, quote: l.quote! };
    return {
      id: `k${i + 1}`,
      source,
      extract_by: l.extract_by ?? 'rule',
      requested: { part_text: l.part_text ?? '', description: l.desc ?? '', qty_text: l.qty_text, uom_text: l.uom_text ?? '', due_text: l.due_text ?? '', certs_text: l.certs_text ?? '', export_text: l.export_text ?? '' },
      expected: {
        sku: asked?.sku ?? null,
        quoted_sku: part?.sku ?? null,
        review: Boolean(l.review) || !asked,
        qty: l.qty,
        uom,
        due_date: due,
        certs,
        certs_unclear: Boolean(l.certs_unclear),
        missing,
        export_hold: exportHold,
        flags: flags.sort(),
        price,
      },
      traps: l.traps,
    };
  });
  const traps = new Map<string, string[]>();
  lines.forEach((l) => l.traps.forEach((t) => traps.set(t, [...(traps.get(t) ?? []), l.id])));
  for (const t of plan.rfq_traps ?? []) traps.set(t, []);
  return {
    rfq_id: plan.id,
    split: plan.split,
    customer_id: plan.customer,
    quote_date: quoteDate,
    defaults: plan.defaults ? { due_date: plan.defaults.due ?? null, certs: plan.defaults.certs ?? [], quote: plan.defaults.quote } : null,
    lines,
    traps: [...traps.entries()].map(([kind, ids]) => ({ kind, lines: ids })).sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(path.join(process.cwd(), 'data', 'erp'), { recursive: true });
  const erp = (f: string) => path.join(process.cwd(), 'data', 'erp', f);
  const head = ['sku', 'category', 'description', 'mfr', 'mfr_part', 'supplier_id', 'supplier_part', 'uom', 'pack_qty', 'supplier_moq', 'cost_cents', 'stock_qty', 'lead_time_days', 'status', 'superseded_by', 'export_controlled', 'certs', 'aliases'];
  fs.writeFileSync(erp('catalog.csv'), toCsv([head, ...parts.map((p) => [p.sku, p.category, p.description, p.mfr, p.mfr_part, p.supplier_id, p.supplier_part, p.uom, p.pack_qty, p.supplier_moq, p.cost_cents, p.stock_qty, p.lead_time_days, p.status, p.superseded_by ?? '', p.export_controlled ? 'Y' : 'N', p.certs.join(';'), p.aliases.join(';')])]));
  fs.writeFileSync(erp('suppliers.csv'), toCsv([['id', 'name', 'email', 'phone', 'default_lead_days'], ...SUPPLIERS.map((s) => [s.id, s.name, s.email, s.phone, s.default_lead_days])]));
  fs.writeFileSync(erp('customer_xref.csv'), toCsv([['customer_id', 'customer_pn', 'sku'], ...XREF.map(([c, pn, mpn]) => [c, pn, sku(mpn)])]));

  fs.rmSync(path.join(OUT, 'rfqs'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'keys'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'keys'), { recursive: true });
  let lines = 0;
  for (const plan of PLANS) {
    const dir = path.join(OUT, 'rfqs', plan.id);
    fs.mkdirSync(dir, { recursive: true });
    const attachments: { filename: string; content_type: string }[] = [];
    if (plan.kind.startsWith('xlsx')) {
      await writeXlsx(plan, path.join(dir, plan.filename!));
      attachments.push({ filename: plan.filename!, content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    } else if (plan.kind.startsWith('pdf')) {
      await writePdf(plan, path.join(dir, plan.filename!));
      attachments.push({ filename: plan.filename!, content_type: 'application/pdf' });
    }
    for (const l of plan.lines) if (l.quote && (plan.kind === 'body' || l.where === 'body') && !plan.body.includes(l.quote)) throw new Error(`${plan.id}: "${l.quote}" is not in the body`);
    const message = { id: plan.id, received_at: plan.received, from: plan.from, to: cfg.distributor.quotes_inbox, subject: plan.subject, body: plan.body, attachments };
    fs.writeFileSync(path.join(dir, 'message.json'), JSON.stringify(message, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'keys', `${plan.id}.key.json`), JSON.stringify(keyFor(plan), null, 2) + '\n');
    lines += plan.lines.length;
  }
  console.log(`Wrote ${parts.length} parts, ${SUPPLIERS.length} suppliers, ${XREF.length} customer part numbers, and ${PLANS.length} RFQs with ${lines} lines (${PLANS.filter((p) => p.split === 'dev').length} dev, ${PLANS.filter((p) => p.split === 'holdout').length} holdout).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
