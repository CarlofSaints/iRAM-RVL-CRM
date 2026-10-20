// Self-check for the Takealot scan rules + PDF text reader. Run: node scripts/test-tal.mts
import assert from 'node:assert/strict';
import { applyScan, parseBookingText, statusCounts, talStage, type TalBooking } from '../lib/talShared.ts';

// Text in the shape of the Booking Confirmation sample (16 May 2025).
const p = parseBookingText(`Booking Confirmation Robert Bosch Pty Ltd
Collection Address: Takealot DC Date of Booking: May 16, 2025
Time Slot: 08:00
Booking Reference Number: TALBQBEAN3732155 TALBQBEAN3732155
Collection Details:
Company Include POs Instruction Nr. Vendor Reference Barcode Qty
Takealot 139751845 1
Takealot 139842696 1
Takealot 139923902 1
Takealot 140431168 2`);
assert.equal(p.brn, 'TALBQBEAN3732155');
assert.equal(p.bookingDate, '2025-05-16');
assert.equal(p.timeSlot, '08:00');
assert.deepEqual(p.instructions.map((i) => [i.instructionNo, i.qty]), [['139751845', 1], ['139842696', 1], ['139923902', 1], ['140431168', 2]]);

// Each cell on its own line, and one row with no qty at all (left 0 for the user to fill).
const q = parseBookingText(`Collection Details:
Takealot
139751845
1
Takealot
140431168
2
Takealot
150000001
Printed by system`);
assert.deepEqual(q.instructions.map((i) => [i.instructionNo, i.qty]), [['139751845', 1], ['140431168', 2], ['150000001', 0]]);

// Real sheet (19 Oct 2026, read off the scan): totals line must not bleed into the last row's qty.
const real = parseBookingText(`Booking Reference Number: TALBKIYGI5477271
Collection Details:
Takealot 188807224 3
Takealot 188855606 1
Takealot 189037256 1
Takealot 189424609 2
Takealot 189549652 1
Takealot 189779260 2
Takealot 189909235 2
Takealot 190456497 3
Takealot 190569855 2
Takealot 190681535
Total units on delivery: 0
Total units to collect: 19`);
assert.equal(real.instructions.length, 10);
assert.equal(real.instructions[9].qty, 0, 'missing qty stays 0, not the totals line');
assert.equal(real.totalUnits, 19);

const now = '2026-10-20T08:00:00.000Z';
let b: TalBooking = {
  id: 'b1', brn: p.brn, instructions: p.instructions, units: [], history: [], createdAt: now, updatedAt: now,
};
const actor = { byName: 'Test' };
const st = (k: string) => talStage(k)!;

// Collect at TAL: 140431168 has 2 slots, only 1 found; an extra unit is refused.
let r = applyScan(b, st('collect_tal'), [
  { instructionNo: '140431168', rrn: 'rrn-a', serial: 's1' },
  { instructionNo: '139751845', rrn: 'RRN-B', serial: 's2' },
], new Set(), actor, now);
assert.ok(r.ok);
assert.equal(r.missing.reduce((t, m) => t + m.count, 0), 3);
b = r.booking!;
assert.equal(statusCounts(b).missing_tal, 3);
assert.equal(statusCounts(b).collected_tal, 2);
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '139751845', rrn: 'RRN-X', serial: 'x' }], new Set(), actor).ok, 'IN full');
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '139842696', rrn: 'RRN-Z', serial: 'z' }], new Set(['RRN-Z']), actor).ok, 'RRN on another booking');
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '139842696', rrn: 'RRN-Y' }], new Set(), actor).ok, 'serial required');

// Receipt into iRam: serial must match; wrong IN refused; unscanned unit reported missing.
assert.ok(!applyScan(b, st('receipt_iram'), [{ instructionNo: '140431168', rrn: 'RRN-A', serial: 'WRONG' }], new Set(), actor).ok);
assert.ok(!applyScan(b, st('receipt_iram'), [{ instructionNo: '139751845', rrn: 'RRN-A', serial: 'S1' }], new Set(), actor).ok);
r = applyScan(b, st('receipt_iram'), [{ instructionNo: '140431168', rrn: 'RRN-A', serial: 'S1' }], new Set(), { ...actor, warehouseName: 'Gauteng' }, now);
assert.ok(r.ok);
assert.deepEqual(r.missing.map((m) => m.rrn), ['RRN-B']);
assert.equal(r.booking!.units.find((u) => u.rrn === 'RRN-A')!.warehouseName, 'Gauteng');

// Skipping a step is refused: RRN-B has not been receipted into iRam.
assert.ok(!applyScan(r.booking!, st('receipt_bsc'), [{ instructionNo: '139751845', rrn: 'RRN-B' }], new Set(), actor).ok);
assert.ok(!applyScan(b, st('receipt_iram'), [], new Set(), actor).ok, 'empty scan');

console.log('test-tal: all checks passed');
