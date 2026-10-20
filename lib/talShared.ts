/**
 * Pure, I/O-free types and rules for the Takealot (TAL) module, so client
 * pages and API routes share them. Keep this file free of imports (see
 * lib/promoShared.ts for why).
 *
 * A TAL booking is a Bosch "Booking Confirmation": one Booking Reference Number
 * (BRN) and several Instruction Numbers (INs), each with a quantity. We only
 * learn WHICH units are in an IN when they are scanned at Takealot — each unit
 * has its own RRN label and a serial number. From then on status is held per
 * unit (RRN), so units on one IN can split (one repaired, one left at BSC).
 */

export type TalUnitStatus =
  | 'collected_tal'
  | 'receipted_iram'
  | 'receipted_bsc'
  | 'collected_bsc'
  | 'unrepairable'
  | 'repaired_iram';

/** An IN slot nobody has scanned yet is still "Booking received". */
export type TalStatus = 'booking_received' | 'missing_tal' | TalUnitStatus;

export const TAL_STATUS_LABELS: Record<TalStatus, string> = {
  booking_received: 'Booking received',
  missing_tal: 'Not found at TAL',
  collected_tal: 'Collected from TAL',
  receipted_iram: 'Receipted – iRam',
  receipted_bsc: 'Receipted by BSC',
  collected_bsc: 'Repaired & collected',
  unrepairable: 'Unrepairable',
  repaired_iram: 'Repaired – iRam IS',
};

export const TAL_STATUS_BADGE: Record<TalStatus, string> = {
  booking_received: 'bg-gray-100 text-gray-600',
  missing_tal: 'bg-red-100 text-red-700',
  collected_tal: 'bg-blue-100 text-blue-700',
  receipted_iram: 'bg-indigo-100 text-indigo-700',
  receipted_bsc: 'bg-amber-100 text-amber-700',
  collected_bsc: 'bg-purple-100 text-purple-700',
  unrepairable: 'bg-red-100 text-red-700',
  repaired_iram: 'bg-emerald-100 text-emerald-700',
};

/** Statuses where the stock is physically in an iRam warehouse (day counter runs). */
export const TAL_IN_WAREHOUSE: TalStatus[] = ['receipted_iram', 'repaired_iram'];

// shortcut: one BSC (Johannesburg). Carl thinks there is a Cape Town branch too; make this a list when that is confirmed.
export const BSC_LOCATION = { name: 'Bosch Service Centre (BSC)', address: '35 Roper St, New Centre, Johannesburg, 2001' };

export type TalStageKey = 'collect_tal' | 'receipt_iram' | 'receipt_bsc' | 'collect_bsc' | 'receipt_repaired';

export interface TalStage {
  key: TalStageKey;
  label: string;
  /** Units must be in this status to be scanned. null = new units against open IN slots. */
  from: TalUnitStatus | null;
  to: TalUnitStatus;
  /** 'capture' = type/scan the serial; 'match' = must equal the serial captured at TAL. */
  serial?: 'capture' | 'match';
  /** Collecting rep + receiving warehouse are recorded on warehouse receipts. */
  needsRepAndWarehouse?: boolean;
  /** Units left unscanned are expected (BSC keeps what it could not fix). */
  partialExpected?: boolean;
}

export const TAL_STAGES: TalStage[] = [
  { key: 'collect_tal', label: 'Collect at TAL', from: null, to: 'collected_tal', serial: 'capture' },
  { key: 'receipt_iram', label: 'Receipt into iRam', from: 'collected_tal', to: 'receipted_iram', serial: 'match', needsRepAndWarehouse: true },
  { key: 'receipt_bsc', label: 'Receipt at BSC', from: 'receipted_iram', to: 'receipted_bsc' },
  { key: 'collect_bsc', label: 'Collect repaired from BSC', from: 'receipted_bsc', to: 'collected_bsc', partialExpected: true },
  { key: 'receipt_repaired', label: 'Receipt repaired into iRam', from: 'collected_bsc', to: 'repaired_iram', needsRepAndWarehouse: true },
];

export const talStage = (key: string) => TAL_STAGES.find((s) => s.key === key);

export interface TalEvent {
  status: TalStatus;
  at: string; // ISO
  byUserId?: string;
  byName?: string;
  repName?: string;
  warehouseName?: string;
  note?: string;
}

export interface TalUnit {
  rrn: string;
  instructionNo: string;
  serial: string;
  status: TalUnitStatus;
  statusAt: string; // ISO — when the current status was set (drives the day counter)
  warehouseId?: string;
  warehouseName?: string;
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
  rrn: string;
  serial?: string;
}

export const normCode = (s: unknown) => String(s ?? '').trim().toUpperCase();

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
export function unitLocation(u: TalUnit): string {
  if (TAL_IN_WAREHOUSE.includes(u.status)) return u.warehouseName || 'iRam';
  if (u.status === 'receipted_bsc' || u.status === 'unrepairable') return 'BSC';
  return 'In transit';
}

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
  if (open) out[b.history.some((h) => h.status === 'collected_tal') ? 'missing_tal' : 'booking_received'] = open;
  return out;
}

export interface ApplyScanResult {
  ok: boolean;
  /** Per-scan problems that block the save (wrong booking, duplicate, serial mismatch...). */
  errors: string[];
  /** Expected units not scanned — they keep their current status. */
  missing: { instructionNo: string; rrn?: string; count: number }[];
  booking?: TalBooking;
}

/**
 * Apply one scan session to a booking. Pure: returns a NEW booking or errors.
 * `rrnsElsewhere` are RRNs already used on OTHER bookings (an RRN is unique to
 * one physical unit, so it can never appear twice).
 */
export function applyScan(
  b: TalBooking,
  stage: TalStage,
  scans: TalScan[],
  rrnsElsewhere: Set<string>,
  actor: { byUserId?: string; byName?: string; repName?: string; warehouseId?: string; warehouseName?: string },
  now = new Date().toISOString(),
): ApplyScanResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const units = b.units.map((u) => ({ ...u, history: [...u.history] }));
  const newUnits: TalUnit[] = [];
  const slotsUsed = new Map<string, number>();

  for (const raw of scans) {
    const rrn = normCode(raw.rrn);
    const ins = normCode(raw.instructionNo);
    const serial = normCode(raw.serial);
    if (!rrn) { errors.push('A scan has no RRN.'); continue; }
    if (seen.has(rrn)) { errors.push(`${rrn} was scanned twice.`); continue; }
    seen.add(rrn);
    if (!b.instructions.some((i) => i.instructionNo === ins)) {
      errors.push(`${rrn}: instruction ${ins || '(blank)'} is not on booking ${b.brn}.`);
      continue;
    }
    if (stage.serial && !serial) { errors.push(`${rrn}: serial number is required.`); continue; }

    if (stage.from === null) {
      if (rrnsElsewhere.has(rrn) || units.some((u) => u.rrn === rrn)) {
        errors.push(`${rrn} is already booked in — an RRN belongs to one unit only.`);
        continue;
      }
      const used = (slotsUsed.get(ins) ?? 0) + 1;
      if (used > openSlots(b, ins)) {
        errors.push(`${rrn}: instruction ${ins} has no units left to collect.`);
        continue;
      }
      slotsUsed.set(ins, used);
      newUnits.push({
        rrn, instructionNo: ins, serial, status: stage.to, statusAt: now,
        history: [{ status: stage.to, at: now, byUserId: actor.byUserId, byName: actor.byName }],
      });
      continue;
    }

    const unit = units.find((u) => u.rrn === rrn);
    if (!unit) { errors.push(`${rrn} is not on booking ${b.brn}.`); continue; }
    if (unit.instructionNo !== ins) { errors.push(`${rrn} belongs to instruction ${unit.instructionNo}, not ${ins}.`); continue; }
    if (unit.status !== stage.from) {
      errors.push(`${rrn} is "${TAL_STATUS_LABELS[unit.status]}", expected "${TAL_STATUS_LABELS[stage.from]}".`);
      continue;
    }
    if (stage.serial === 'match' && unit.serial && unit.serial !== serial) {
      errors.push(`${rrn}: serial ${serial} does not match ${unit.serial} captured at Takealot.`);
      continue;
    }
    if (stage.serial === 'match' && !unit.serial) unit.serial = serial;
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
  const history = [...b.history, {
    status: stage.to, at: now, ...actor,
    note: `${stage.label}: ${seen.size} unit(s)${missing.length ? `, ${missing.reduce((t, m) => t + m.count, 0)} not scanned` : ''}`,
  }];
  return { ok: true, errors, missing, booking: { ...b, units: [...units, ...newUnits], history, updatedAt: now } };
}

// ── Booking Confirmation PDF text → fields ───────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface ParsedBooking {
  brn: string;
  bookingDate: string;
  timeSlot: string;
  supplierName: string;
  instructions: TalInstruction[];
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
  return { brn, bookingDate, timeSlot, supplierName, instructions, totalUnits };
}
