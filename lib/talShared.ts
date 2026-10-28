/**
 * Pure, I/O-free types and rules for the Takealot (TAL) module, so client
 * pages and API routes share them. Keep this file free of imports (see
 * lib/promoShared.ts for why).
 *
 * A TAL booking is a Bosch "Booking Confirmation": one Booking Reference Number
 * (BRN) and several Instruction Numbers (INs), each with a quantity. We only
 * learn WHICH units are in an IN when they are scanned at Takealot — each unit
 * has its own RRN label (the RRN is the unit's serial). From then on status is held per
 * unit (RRN), so units on one IN can split (one repaired, one left at BSC).
 *
 * A product with no RRN label gets a stand-in id (NO-RRN-<IN>-<n>) plus a typed
 * description. Takealot approves returns per Zendesk ticket and one booking can
 * span several tickets, so the ticket is held per unit.
 */

export type TalUnitStatus =
  | 'receipted_iram'
  | 'rejected_new'
  | 'receipted_bsc'
  | 'unrepairable'
  | 'repaired_iram'
  | 'returned_tal';

/**
 * An IN slot nobody has scanned yet is still "Booking received".
 * collected_tal / collected_bsc only appear in history from before the
 * separate collect steps were dropped (28 Oct 2026).
 */
export type TalStatus = 'booking_received' | 'missing_tal' | 'collected_tal' | 'collected_bsc' | TalUnitStatus;

export const TAL_STATUS_LABELS: Record<TalStatus, string> = {
  booking_received: 'Booking received',
  missing_tal: 'Not found at TAL',
  collected_tal: 'Collected from TAL',
  receipted_iram: 'Collected from TAL – at iRam',
  rejected_new: 'Rejected – New/Unopened',
  receipted_bsc: 'At BSC',
  collected_bsc: 'Repaired & collected',
  unrepairable: 'Unrepairable',
  repaired_iram: 'Back from BSC – at iRam',
  returned_tal: 'Returned to TAL',
};

export const TAL_STATUS_BADGE: Record<TalStatus, string> = {
  booking_received: 'bg-gray-100 text-gray-600',
  missing_tal: 'bg-red-100 text-red-700',
  collected_tal: 'bg-blue-100 text-blue-700',
  receipted_iram: 'bg-indigo-100 text-indigo-700',
  rejected_new: 'bg-gray-200 text-gray-700',
  receipted_bsc: 'bg-amber-100 text-amber-700',
  collected_bsc: 'bg-purple-100 text-purple-700',
  unrepairable: 'bg-red-100 text-red-700',
  repaired_iram: 'bg-emerald-100 text-emerald-700',
  returned_tal: 'bg-teal-100 text-teal-700',
};

/** Statuses where the stock is physically in an iRam warehouse (day counter runs). */
export const TAL_IN_WAREHOUSE: TalStatus[] = ['receipted_iram', 'repaired_iram'];

/** Takealot has a Gauteng and a Cape Town DC, each served by its own Bosch Service Centre. */
export type TalRegion = 'GAU' | 'CPT';
export const TAL_REGIONS: Record<TalRegion, { label: string; tal: string; bsc: string; bscAddress: string; talAddress: string }> = {
  GAU: {
    label: 'Gauteng', tal: 'TAL GAU', bsc: 'BSC GAU', bscAddress: '35 Roper St, New Centre, Johannesburg, 2001',
    // Worded as on Takealot's "Dispute Delivery Schedule" form.
    talAddress: 'Johannesburg (5 Merlot Close, JT Ross Park, Plumbago 4, Witfontein Ext 55, Kempton Park, 1619)',
  },
  // shortcut: Cape Town DC address not seen on a return form yet; add it when one comes through.
  CPT: { label: 'Cape Town', tal: 'TAL CPT', bsc: 'BSC CPT', bscAddress: '136 Democracy Way, Milnerton', talAddress: 'Cape Town' },
};
/** Bookings loaded before regions existed were all Gauteng. */
export const regionOf = (b: Pick<TalBooking, 'region'>): TalRegion => b.region ?? 'GAU';

/** Why BSC did not fix a unit. Damage and out-of-warranty are still billed to Takealot. */
export type NotFixedReason = 'beyond_repair' | 'neglect' | 'out_of_warranty';
export const NOT_FIXED_REASONS: Record<NotFixedReason, { label: string; billTal: boolean }> = {
  beyond_repair: { label: 'Beyond repair (warranty)', billTal: false },
  neglect: { label: 'Damage / neglect – bill TAL', billTal: true },
  out_of_warranty: { label: 'Out of warranty – bill TAL', billTal: true },
};

export type TalStageKey = 'collect_tal' | 'receipt_bsc' | 'collect_bsc' | 'return_tal';

export interface TalStage {
  key: TalStageKey;
  label: string;
  /** Units must be in this status to be scanned. null = new units against open IN slots. */
  from: TalUnitStatus | null;
  to: TalUnitStatus;
  /** Collecting rep + receiving warehouse are recorded on warehouse receipts. */
  needsRepAndWarehouse?: boolean;
  /** Units left unscanned are expected (BSC keeps what it could not fix). */
  partialExpected?: boolean;
  /** Each unit needs its Takealot Zendesk ticket first (their approval to return). */
  needsTicket?: boolean;
  /** Units are scanned one by one, from any booking, with no booking scan first. */
  anyBooking?: boolean;
}

/** Step numbers follow the Booking PDF load (step 1). */
export const TAL_STAGES: TalStage[] = [
  { key: 'collect_tal', label: 'Collected from TAL', from: null, to: 'receipted_iram', needsRepAndWarehouse: true },
  { key: 'receipt_bsc', label: 'BSC Drop-off', from: 'receipted_iram', to: 'receipted_bsc' },
  // BSC hands back whatever it repaired, from any booking; what it keeps stays "At BSC".
  { key: 'collect_bsc', label: 'Collected from BSC', from: 'receipted_bsc', to: 'repaired_iram', needsRepAndWarehouse: true, partialExpected: true, anyBooking: true },
  { key: 'return_tal', label: 'Return to TAL', from: 'repaired_iram', to: 'returned_tal', needsTicket: true, partialExpected: true, anyBooking: true },
];

export const talStage = (key: string) => TAL_STAGES.find((s) => s.key === key);

export interface TalEvent {
  /** Absent on note-only events (e.g. Zendesk ticket recorded), which move no stock. */
  status?: TalStatus;
  at: string; // ISO
  byUserId?: string;
  byName?: string;
  repName?: string;
  warehouseName?: string;
  note?: string;
}

export interface TalUnit {
  /** The RRN label, or NO-RRN-<IN>-<n> when the product had none (see noRrn). */
  rrn: string;
  instructionNo: string;
  noRrn?: boolean;
  /** Typed in for a no-RRN product, or read off Takealot's approval email. */
  description?: string;
  /** Takealot Zendesk ticket approving this unit's return. */
  returnTicket?: string;
  status: TalUnitStatus;
  statusAt: string; // ISO — when the current status was set (drives the day counter)
  warehouseId?: string;
  warehouseName?: string;
  /** Set when marked Unrepairable. */
  notFixedReason?: NotFixedReason;
  history: TalEvent[];
}

export interface TalInstruction {
  instructionNo: string;
  qty: number;
}

export interface TalBooking {
  id: string;
  brn: string;
  clientId?: string;
  supplierName?: string;
  bookingDate?: string; // YYYY-MM-DD
  timeSlot?: string; // HH:MM
  collectionAddress?: string;
  region?: TalRegion;
  instructions: TalInstruction[];
  units: TalUnit[];
  history: TalEvent[];
  sourceFileName?: string;
  createdAt: string;
  updatedAt: string;
}

/** One scanned unit as sent by the scan screen. */
export interface TalScan {
  instructionNo: string;
  /** Blank for a new no-RRN product at Collected from TAL. */
  rrn: string;
  /** Product has no RRN label: matched on the instruction, described in words. */
  noRrn?: boolean;
  description?: string;
  /** Collected from TAL only: refused at Takealot because it is new and unopened. */
  rejected?: boolean;
}

type Actor = { byUserId?: string; byName?: string; repName?: string; warehouseId?: string; warehouseName?: string };

export const normCode = (s: unknown) => String(s ?? '').trim().toUpperCase();
const cleanText = (s: unknown, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const NO_RRN_PREFIX = 'NO-RRN-';
/** Short label for a unit: its RRN, or "No RRN: <description>". */
export const unitLabel = (u: Pick<TalUnit, 'rrn' | 'noRrn' | 'description'>) =>
  u.noRrn ? `No RRN${u.description ? `: ${u.description}` : ''}` : u.rrn;

/** Units booked against an IN that are still outstanding at Takealot. */
export function openSlots(b: TalBooking, instructionNo: string): number {
  const ins = b.instructions.find((i) => i.instructionNo === instructionNo);
  if (!ins) return 0;
  return ins.qty - b.units.filter((u) => u.instructionNo === instructionNo).length;
}

/** Units the given stage expects to see, per IN. */
export function expectedUnits(b: TalBooking, stage: TalStage): TalUnit[] {
  return stage.from ? b.units.filter((u) => u.status === stage.from) : [];
}

/** Where a unit physically is, from its status. */
export function unitLocation(u: TalUnit, b: Pick<TalBooking, 'region'>): string {
  if (TAL_IN_WAREHOUSE.includes(u.status)) return u.warehouseName || 'iRam';
  if (u.status === 'receipted_bsc' || u.status === 'unrepairable') return TAL_REGIONS[regionOf(b)].bsc;
  if (u.status === 'returned_tal' || u.status === 'rejected_new') return TAL_REGIONS[regionOf(b)].tal;
  return 'In transit';
}

/** Units BSC did not fix whose cost still goes to Takealot. */
export const unitsToBillTal = (b: TalBooking) =>
  b.units.filter((u) => u.notFixedReason && NOT_FIXED_REASONS[u.notFixedReason].billTal);

/** Whole days since an ISO time, never negative. */
export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

/** Count per status across a booking, with unscanned IN slots as "Booking received". */
export function statusCounts(b: TalBooking): Partial<Record<TalStatus, number>> {
  const out: Partial<Record<TalStatus, number>> = {};
  for (const u of b.units) out[u.status] = (out[u.status] ?? 0) + 1;
  const open = b.instructions.reduce((t, i) => t + Math.max(0, openSlots(b, i.instructionNo)), 0);
  // Once Takealot has been visited, an IN slot nobody scanned was not there.
  // It can still be collected on a later visit.
  const visited = b.history.some((h) => h.status === 'collected_tal' || h.status === 'receipted_iram');
  if (open) out[visited ? 'missing_tal' : 'booking_received'] = open;
  return out;
}

export interface ApplyScanResult {
  ok: boolean;
  /** Per-scan problems that block the save (wrong booking, duplicate, wrong status...). */
  errors: string[];
  /** Expected units not scanned — they keep their current status. */
  missing: { instructionNo: string; rrn?: string; count: number }[];
  booking?: TalBooking;
}

/**
 * Apply one scan session to ONE booking (Collected from TAL, BSC Drop-off).
 * Pure: returns a NEW booking or errors. `rrnsElsewhere` are RRNs already used
 * on OTHER bookings (an RRN is unique to one physical unit).
 */
export function applyScan(
  b: TalBooking,
  stage: TalStage,
  scans: TalScan[],
  rrnsElsewhere: Set<string>,
  actor: Actor,
  now = new Date().toISOString(),
): ApplyScanResult {
  if (stage.anyBooking) return { ok: false, errors: [`${stage.label} is scanned unit by unit, not per booking.`], missing: [] };
  const errors: string[] = [];
  const seen = new Set<string>();
  const units = b.units.map((u) => ({ ...u, history: [...u.history] }));
  const newUnits: TalUnit[] = [];
  const slotsUsed = new Map<string, number>();
  let rejected = 0;

  for (const raw of scans) {
    const ins = normCode(raw.instructionNo);
    const isNew = stage.from === null;
    const noRrn = isNew && !!raw.noRrn;
    const description = cleanText(raw.description);
    if (!b.instructions.some((i) => i.instructionNo === ins)) {
      errors.push(`${normCode(raw.rrn) || 'A product'}: instruction ${ins || '(blank)'} is not on booking ${b.brn}.`);
      continue;
    }

    if (isNew) {
      if (noRrn && !description) { errors.push(`A product on instruction ${ins} has no RRN and no description.`); continue; }
      const used = (slotsUsed.get(ins) ?? 0) + 1;
      if (used > openSlots(b, ins)) {
        errors.push(`${noRrn ? `No-RRN product (${description})` : normCode(raw.rrn)}: instruction ${ins} has no units left to collect.`);
        continue;
      }
      const rrn = noRrn ? `${NO_RRN_PREFIX}${ins}-${units.concat(newUnits).filter((u) => u.instructionNo === ins && u.noRrn).length + 1}` : normCode(raw.rrn);
      if (!rrn) { errors.push('A scan has no RRN.'); continue; }
      if (seen.has(rrn)) { errors.push(`${rrn} was scanned twice.`); continue; }
      seen.add(rrn);
      if (rrnsElsewhere.has(rrn) || units.some((u) => u.rrn === rrn)) {
        errors.push(`${rrn} is already booked in — an RRN belongs to one unit only.`);
        continue;
      }
      slotsUsed.set(ins, used);
      // Refused at Takealot: the slot is accounted for but the unit stays at TAL.
      const status: TalUnitStatus = raw.rejected ? 'rejected_new' : stage.to;
      if (raw.rejected) rejected++;
      const inWh = status === stage.to && stage.needsRepAndWarehouse;
      newUnits.push({
        rrn, instructionNo: ins, status, statusAt: now,
        ...(noRrn ? { noRrn: true } : {}),
        ...(description ? { description } : {}),
        ...(inWh ? { warehouseId: actor.warehouseId, warehouseName: actor.warehouseName } : {}),
        history: [{
          status, at: now, ...(inWh ? actor : { byUserId: actor.byUserId, byName: actor.byName }),
          ...(noRrn ? { note: `No RRN on product: ${description}` } : {}),
        }],
      });
      continue;
    }

    const rrn = normCode(raw.rrn);
    if (!rrn) { errors.push('A scan has no RRN.'); continue; }
    if (seen.has(rrn)) { errors.push(`${rrn} was scanned twice.`); continue; }
    seen.add(rrn);
    const unit = units.find((u) => u.rrn === rrn);
    if (!unit) { errors.push(`${rrn} is not on booking ${b.brn}.`); continue; }
    if (unit.instructionNo !== ins) { errors.push(`${rrn} belongs to instruction ${unit.instructionNo}, not ${ins}.`); continue; }
    if (unit.status !== stage.from) {
      errors.push(`${unitLabel(unit)} is "${TAL_STATUS_LABELS[unit.status]}", expected "${TAL_STATUS_LABELS[stage.from!]}".`);
      continue;
    }
    unit.status = stage.to;
    unit.statusAt = now;
    if (stage.needsRepAndWarehouse) { unit.warehouseId = actor.warehouseId; unit.warehouseName = actor.warehouseName; }
    unit.history.push({ status: stage.to, at: now, ...actor });
  }

  // What the stage expected but nobody scanned.
  const missing: ApplyScanResult['missing'] = [];
  if (stage.from === null) {
    for (const i of b.instructions) {
      const left = openSlots(b, i.instructionNo) - (slotsUsed.get(i.instructionNo) ?? 0);
      if (left > 0) missing.push({ instructionNo: i.instructionNo, count: left });
    }
  } else {
    for (const u of b.units) {
      if (u.status === stage.from && !seen.has(u.rrn)) missing.push({ instructionNo: u.instructionNo, rrn: u.rrn, count: 1 });
    }
  }

  if (errors.length) return { ok: false, errors, missing };
  if (seen.size === 0) return { ok: false, errors: ['Nothing was scanned.'], missing };
  const notScanned = missing.reduce((t, m) => t + m.count, 0);
  const history = [...b.history, {
    status: stage.to, at: now, ...actor,
    note: `${stage.label}: ${seen.size - rejected} unit(s)${rejected ? `, ${rejected} rejected new/unopened` : ''}${notScanned ? `, ${notScanned} not scanned` : ''}`,
  }];
  return { ok: true, errors, missing, booking: { ...b, units: [...units, ...newUnits], history, updatedAt: now } };
}

export interface ApplyUnitScansResult {
  ok: boolean;
  errors: string[];
  /** Every booking, with the scanned units moved. */
  all?: TalBooking[];
  /** The units that moved, for the save message and the return form. */
  moved: { bookingId: string; brn: string; unit: TalUnit }[];
}

/**
 * Apply a unit-by-unit session (Collected from BSC, Return to TAL) across ALL
 * bookings: BSC hands back units from many bookings in one go. A unit is found
 * by its RRN, or for a no-RRN product by its instruction (no-RRN units first).
 */
export function applyUnitScans(
  all: TalBooking[],
  stage: TalStage,
  scans: TalScan[],
  actor: Actor,
  now = new Date().toISOString(),
): ApplyUnitScansResult {
  if (!stage.anyBooking || !stage.from) return { ok: false, errors: [`${stage.label} is scanned per booking.`], moved: [] };
  const errors: string[] = [];
  const next = all.map((b) => ({ ...b, history: [...b.history], units: b.units.map((u) => ({ ...u, history: [...u.history] })) }));
  const moved: ApplyUnitScansResult['moved'] = [];
  const taken = new Set<TalUnit>();

  for (const raw of scans) {
    let hit: { b: TalBooking; u: TalUnit } | undefined;
    const description = cleanText(raw.description);
    if (raw.noRrn) {
      const ins = normCode(raw.instructionNo);
      const b = next.find((x) => x.instructions.some((i) => i.instructionNo === ins));
      if (!b) { errors.push(`Instruction ${ins || '(blank)'} is not on any booking.`); continue; }
      const free = b.units.filter((u) => u.instructionNo === ins && u.status === stage.from && !taken.has(u));
      const u = free.find((x) => x.noRrn) ?? free[0];
      if (!u) { errors.push(`Instruction ${ins} has no unit "${TAL_STATUS_LABELS[stage.from]}" left.`); continue; }
      hit = { b, u };
    } else {
      const rrn = normCode(raw.rrn);
      if (!rrn) { errors.push('A scan has no RRN.'); continue; }
      const b = next.find((x) => x.units.some((u) => u.rrn === rrn));
      const u = b?.units.find((x) => x.rrn === rrn);
      if (!b || !u) { errors.push(`${rrn} is not on any booking.`); continue; }
      if (taken.has(u)) { errors.push(`${rrn} was scanned twice.`); continue; }
      if (u.status !== stage.from) {
        errors.push(`${rrn} is "${TAL_STATUS_LABELS[u.status]}", expected "${TAL_STATUS_LABELS[stage.from]}".`);
        continue;
      }
      hit = { b, u };
    }
    const { b, u } = hit;
    if (stage.needsTicket && !u.returnTicket) {
      errors.push(`${unitLabel(u)} has no Takealot approval (Zendesk ticket) yet. Load the approval email first.`);
      continue;
    }
    taken.add(u);
    u.status = stage.to;
    u.statusAt = now;
    if (stage.needsRepAndWarehouse) { u.warehouseId = actor.warehouseId; u.warehouseName = actor.warehouseName; }
    if (raw.noRrn && description && !u.description) u.description = description;
    u.history.push({ status: stage.to, at: now, ...actor, ...(raw.noRrn ? { note: `No RRN on product${description ? `: ${description}` : ''}` } : {}) });
    moved.push({ bookingId: b.id, brn: b.brn, unit: u });
  }

  if (errors.length) return { ok: false, errors, moved: [] };
  if (!moved.length) return { ok: false, errors: ['Nothing was scanned.'], moved: [] };
  for (const b of next) {
    const n = moved.filter((m) => m.bookingId === b.id).length;
    if (!n) continue;
    b.history.push({ status: stage.to, at: now, ...actor, note: `${stage.label}: ${n} unit(s)` });
    b.updatedAt = now;
  }
  return { ok: true, errors, all: next, moved };
}

// ── Takealot return approval email → ticket per RRN ──────────────────────────

export interface ParsedApproval {
  ticket: string;
  rrn: string;
  description: string;
}

const RRN_RE = /RRN-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}/gi;

/**
 * Read Zendesk ticket numbers and the RRNs under them from pasted approval
 * emails (one or several in a thread). Each RRN belongs to the ticket named
 * most recently before it; an RRN seen twice keeps its first ticket. The
 * description is what is left of the RRN's line once codes, prices, the DC and
 * the "no fault found" wording are taken out. Shown for checking before saving.
 */
export function parseApprovalText(text: string): ParsedApproval[] {
  const out: ParsedApproval[] = [];
  let ticket = '';
  for (const line of text.split(/\r?\n/)) {
    const t = [...line.matchAll(/ticket[^#\n]{0,40}#\s*(\d{5,})/gi)];
    if (t.length) ticket = t[t.length - 1][1];
    else if (/^\s*#\s*(\d{5,})\s*$/.test(line) && /ticket/i.test(text)) ticket = line.trim().replace('#', '').trim();
    const rrns = [...line.matchAll(RRN_RE)].map((m) => m[0].toUpperCase());
    if (!rrns.length || !ticket) continue;
    // Several RRNs on one line (a form confirmation) carry no per-item description.
    const description = rrns.length > 1 ? '' : line
      .replace(RRN_RE, '')
      .replace(/no (manufacturing )?faults?( found)?/gi, '')
      .replace(/\bR\s?\d[\d,]*\.\d{2}\b|\b\d{1,3}(,\d{3})*\.\d{2}\b/g, '')
      .replace(/\b\d{6,}\b/g, '')
      .replace(/\b(JHB|CPT)( DC)?\b|\bCompleted\b/g, '')
      .replace(/\s\d{1,2}(?=\s*(-|$))/g, ' ')
      .replace(/(\s*-\s*){2,}/g, ' - ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
      .trim();
    for (const rrn of rrns) {
      if (out.some((o) => o.rrn === rrn)) continue;
      out.push({ ticket, rrn, description: description.slice(0, 200) });
    }
  }
  return out;
}

/**
 * Answers for Takealot's "Dispute Delivery Schedule" Google Form, one per
 * ticket, for the units being returned. Barcodes are not known to Flow.
 */
export function returnFormAnswers(
  units: Pick<TalUnit, 'rrn' | 'noRrn' | 'description' | 'returnTicket'>[],
  opts: { deliveryDate: string; region: TalRegion; vehicleReg?: string; supplierName?: string },
): { ticket: string; text: string }[] {
  const tickets = [...new Set(units.map((u) => u.returnTicket ?? ''))];
  const [y, m, d] = opts.deliveryDate.split('-');
  return tickets.map((ticket) => {
    const us = units.filter((u) => (u.returnTicket ?? '') === ticket);
    return {
      ticket,
      text: [
        `Delivery Date: ${d}.${m}.${y}`,
        `Warehouse: ${TAL_REGIONS[opts.region].talAddress}`,
        'Courier Name: IRAM',
        `Vehicle / Courier Registration: ${opts.vehicleReg?.trim() || ''}`,
        `Seller / Supplier Name: ${(opts.supplierName || 'ROBERT BOSCH').toUpperCase()}`,
        `Ticket Reference: #${ticket}`,
        `RRN Reference: ${us.map((u) => (u.noRrn ? 'NO RRN' : u.rrn)).join(' / ')}`,
        'Item Barcode: ',
        `Item Description: ${us.map((u) => u.description || '?').join(' / ')}`,
      ].join('\n'),
    };
  });
}

// ── Booking Confirmation PDF text → fields ───────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface ParsedBooking {
  brn: string;
  bookingDate: string;
  timeSlot: string;
  supplierName: string;
  instructions: TalInstruction[];
  /** '' = the PDF named neither city, so the user must pick; never guessed. */
  region: TalRegion | '';
  /** "Total units to collect" printed on the sheet, to cross-check the qtys. 0 = not found. */
  totalUnits?: number;
}

/**
 * Read the fields off the text of a Bosch/Takealot Booking Confirmation.
 * Anything it can't find comes back blank — the import screen shows the result
 * for checking before it is saved, so a miss is fixed by hand, never guessed.
 */
export function parseBookingText(text: string): ParsedBooking {
  const brn = text.match(/Booking\s+Reference\s+Number:?\s*([A-Z0-9]{6,})/i)?.[1]?.toUpperCase() ?? '';
  const timeSlot = text.match(/Time\s+Slot:?\s*(\d{1,2}:\d{2})/i)?.[1] ?? '';
  const supplierName = text.match(/Booking\s+Confirmation\s+([^\n]*?(?:Pty|Ltd)[^\n]*)/i)?.[1]?.trim() ?? '';

  // "May 16, 2025" — built by hand, NOT new Date(): a local-midnight date shifts a day in toISOString.
  let bookingDate = '';
  const d = text.match(/Date\s+of\s+Booking:?\s*([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (d) {
    const m = MONTHS.indexOf(d[1].slice(0, 3).toLowerCase());
    if (m >= 0) bookingDate = `${d[3]}-${String(m + 1).padStart(2, '0')}-${d[2].padStart(2, '0')}`;
  }

  // Collection Details rows: "Takealot <IN> ... <qty>". The PDF reader may put each
  // cell on its own line, so a row is everything up to the next "Takealot", and the
  // qty is the first small number after the IN. No qty found = 0, which the import
  // screen flags and the save refuses, so it is typed in rather than guessed.
  const instructions: TalInstruction[] = [];
  const details = (text.split(/Collection\s+Details:?/i)[1] ?? '').split(/Total\s+units/i)[0];
  for (const row of details.split(/\bTakealot\b/i).slice(1)) {
    const m = row.match(/\b(\d{6,})\b([\s\S]*)/);
    if (!m) continue;
    instructions.push({ instructionNo: m[1], qty: Number(m[2].match(/\b(\d{1,3})\b/)?.[1] ?? 0) });
  }
  const totalUnits = Number(text.match(/Total\s+units\s+to\s+collect:?\s*(\d+)/i)?.[1] ?? 0);
  // The collection address names the DC city ("Johannesburg DC 3"). Only a clear,
  // single match counts; anything else is left blank for the user to choose.
  const head = text.split(/Collection\s+Details/i)[0];
  const cpt = /Cape\s*Town/i.test(head), gau = /Johannesburg|Gauteng|Midrand|Witfontein/i.test(head);
  const region: TalRegion | '' = cpt === gau ? '' : cpt ? 'CPT' : 'GAU';
  return { brn, bookingDate, timeSlot, supplierName, instructions, region, totalUnits };
}
