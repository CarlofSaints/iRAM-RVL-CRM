// Self-check for the Takealot scan rules + PDF text reader. Run: node scripts/test-tal.mts
import assert from 'node:assert/strict';
import {
  applyScan, applyUnitScans, parseApprovalText, returnFormAnswers, parseBookingText, statusCounts, talStage, unitLocation, unitsToBillTal,
  type TalBooking,
} from '../lib/talShared.ts';

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
assert.equal(p.region, '', 'no city named: left for the user, never guessed');
assert.equal(parseBookingText('Collection Address: Takealot DC\nJohannesburg DC 3\nCollection Details:').region, 'GAU');
assert.equal(parseBookingText('Collection Address: Takealot DC Cape Town DC 1\nCollection Details:').region, 'CPT');

const now = '2026-10-20T08:00:00.000Z';
let b: TalBooking = {
  id: 'b1', brn: p.brn, instructions: p.instructions, units: [], history: [], createdAt: now, updatedAt: now,
};
const actor = { byName: 'Test', warehouseName: 'Gauteng' };
const st = (k: string) => talStage(k)!;

// Collected from TAL: 140431168 has 2 slots, one collected, one rejected new/unopened.
// A no-RRN product needs a description and lands in the warehouse like any other.
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '139842696', rrn: '', noRrn: true }], new Set(), actor).ok, 'no-RRN needs a description');
let r = applyScan(b, st('collect_tal'), [
  { instructionNo: '140431168', rrn: 'rrn-a' },
  { instructionNo: '140431168', rrn: 'RRN-R', rejected: true },
  { instructionNo: '139751845', rrn: 'RRN-B' },
  { instructionNo: '139842696', rrn: '', noRrn: true, description: 'Blue drill' },
], new Set(), actor, now);
assert.ok(r.ok, r.errors.join('; '));
b = r.booking!;
assert.equal(statusCounts(b).missing_tal, 1);
assert.equal(statusCounts(b).receipted_iram, 3);
assert.equal(statusCounts(b).rejected_new, 1);
const rej = b.units.find((u) => u.rrn === 'RRN-R')!;
assert.equal(rej.warehouseName, undefined, 'rejected stays at TAL');
assert.equal(unitLocation(rej, b), 'TAL GAU');
const nr = b.units.find((u) => u.noRrn)!;
assert.equal(nr.rrn, 'NO-RRN-139842696-1');
assert.equal(nr.warehouseName, 'Gauteng');
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '140431168', rrn: 'RRN-X' }], new Set(), actor).ok, 'IN full (rejected counts)');
assert.ok(!applyScan(b, st('collect_tal'), [{ instructionNo: '139923902', rrn: 'RRN-Z' }], new Set(['RRN-Z']), actor).ok, 'RRN on another booking');

// BSC Drop-off: wrong IN refused; a no-RRN unit goes by its stand-in id.
assert.ok(!applyScan(b, st('receipt_bsc'), [{ instructionNo: '139751845', rrn: 'RRN-A' }], new Set(), actor).ok);
r = applyScan(b, st('receipt_bsc'), [
  { instructionNo: '140431168', rrn: 'RRN-A' }, { instructionNo: '139751845', rrn: 'RRN-B' }, { instructionNo: '139842696', rrn: nr.rrn },
], new Set(), actor, now);
assert.ok(r.ok, r.errors.join('; '));
assert.equal(r.missing.length, 0);
b = r.booking!;
assert.ok(!applyScan(b, st('collect_bsc'), [{ instructionNo: '140431168', rrn: 'RRN-A' }], new Set(), actor).ok, 'unit stages refuse a per-booking save');

// Collected from BSC: any booking, unit by unit; the no-RRN one is found by its instruction.
const other: TalBooking = {
  id: 'b2', brn: 'TALOTHER', instructions: [{ instructionNo: '999999999', qty: 1 }], createdAt: now, updatedAt: now, history: [],
  units: [{ rrn: 'RRN-O', instructionNo: '999999999', status: 'receipted_bsc', statusAt: now, history: [] }],
};
let u = applyUnitScans([b, other], st('collect_bsc'), [
  { instructionNo: '', rrn: 'rrn-o' }, { instructionNo: '', rrn: 'RRN-A' }, { instructionNo: '139842696', rrn: '', noRrn: true },
], actor, now);
assert.ok(u.ok, u.errors.join('; '));
assert.deepEqual(u.moved.map((m) => m.unit.rrn).sort(), ['NO-RRN-139842696-1', 'RRN-A', 'RRN-O']);
assert.equal(u.all!.find((x) => x.id === 'b1')!.units.find((x) => x.rrn === 'RRN-B')!.status, 'receipted_bsc', 'kept at BSC');
assert.equal(u.all!.find((x) => x.id === 'b1')!.units.find((x) => x.rrn === 'RRN-A')!.warehouseName, 'Gauteng');
assert.ok(!applyUnitScans(u.all!, st('collect_bsc'), [{ instructionNo: '', rrn: 'RRN-A' }], actor).ok, 'already collected');

// Return to TAL needs a ticket on the unit.
assert.ok(!applyUnitScans(u.all!, st('return_tal'), [{ instructionNo: '', rrn: 'RRN-A' }], actor).ok, 'no ticket');
const withTicket = u.all!.map((x) => ({ ...x, units: x.units.map((y) => (y.rrn === 'RRN-A' ? { ...y, returnTicket: '77125620' } : y)) }));
u = applyUnitScans(withTicket, st('return_tal'), [{ instructionNo: '', rrn: 'RRN-A' }], actor, now);
assert.ok(u.ok, u.errors.join('; '));
assert.equal(u.moved[0].unit.status, 'returned_tal');

// Unrepairable billing still works.
const done: TalBooking = {
  ...b, region: 'CPT', units: [
    { rrn: 'R2', instructionNo: '139751845', status: 'unrepairable', notFixedReason: 'neglect', statusAt: now, history: [] },
    { rrn: 'R3', instructionNo: '139751845', status: 'unrepairable', notFixedReason: 'beyond_repair', statusAt: now, history: [] },
  ],
};
assert.equal(unitLocation(done.units[0], done), 'BSC CPT');
assert.deepEqual(unitsToBillTal(done).map((x) => x.rrn), ['R2']);

// Approval emails: the three shapes Takealot sent (Sep/Oct 2026 and Oct 2025), in one forwarded thread.
const approval = parseApprovalText(`Return RFCs Tickets:  #77125620 <https://help.takealot.com/hc/requests/77125620>   &  #77125823  & #60207666
Please refer to Zendesk ticket #77125620 <https://help.takealot.com/hc/requests/77125620>  for further context.Item for Return:
JHB\t 176008240\t Completed
1,147.06\t Bosch - Cordless Impact Drill / Driver GSB 183-LI with 1 Battery - Bosch\t 1\t RRN-AA488-QMYB - no manufacturing faults
JHB\t 177526939\t Completed\t 629.29\t Bosch Professional Jigsaw 500 W GST 680 - Gst 680\t 1\t RRN-4JDK5-5OPP - no manufacturing faults
Please refer to Zendesk ticket #77125823   for further context.Item for Return:
RRN-GAWQM-9X6K - 164630622 - JHB\t Dremel - 8240 (8240-5/65) Cordless Rotary Multitool - No fault found - R3571.48
RRN-ZM56D-DVN6 - 166126809 - JHB\t Bosch - Angle Grinder - GWS 700 - No fault found - R489.29
Please refer to zendesk ticket #60207666
125014199 - JHB DC\t RRN-68BX5-MARO - No fault found - R1,167.14
Ticket Reference: #77125823 RRN Reference: RRN-AA488-QMYB / RRN-NEW01-AAAA`);
assert.deepEqual(approval.map((a) => [a.ticket, a.rrn, a.description]), [
  ['77125620', 'RRN-AA488-QMYB', 'Bosch - Cordless Impact Drill / Driver GSB 183-LI with 1 Battery - Bosch'],
  ['77125620', 'RRN-4JDK5-5OPP', 'Bosch Professional Jigsaw 500 W GST 680 - Gst 680'],
  ['77125823', 'RRN-GAWQM-9X6K', 'Dremel - 8240 (8240-5/65) Cordless Rotary Multitool'],
  ['77125823', 'RRN-ZM56D-DVN6', 'Bosch - Angle Grinder - GWS 700'],
  ['60207666', 'RRN-68BX5-MARO', ''],
  ['77125823', 'RRN-NEW01-AAAA', ''],
]);

const form = returnFormAnswers(
  [
    { rrn: 'RRN-A', returnTicket: '1', description: 'Jigsaw', region: 'GAU', supplierName: 'Robert Bosch Pty Ltd' },
    { rrn: 'NO-RRN-1-1', noRrn: true, returnTicket: '1', description: 'Drill', region: 'GAU' },
    { rrn: 'RRN-C', returnTicket: '2', region: 'CPT' },
  ],
  { deliveryDate: '2026-10-05', vehicleReg: 'MH89NXGP' },
);
assert.equal(form.length, 2);
assert.match(form[0].text, /Delivery Date: 05\.10\.2026/);
assert.match(form[0].text, /RRN Reference: RRN-A \/ NO RRN/);
assert.match(form[0].text, /Item Description: Jigsaw \/ Drill/);
assert.match(form[0].text, /Supplier Name: ROBERT BOSCH\n/);
assert.match(form[1].text, /Ticket Reference: #2/);
assert.match(form[1].text, /Warehouse: Cape Town/, 'each ticket uses its own booking DC');
assert.match(returnFormAnswers([{ rrn: 'R', returnTicket: '1' }], { deliveryDate: '' })[0].text, /Delivery Date: \n/, 'blank date stays blank');

// A no-RRN scan never steals a unit scanned by RRN in the same session, and says which RRN it took.
const lost: TalBooking = {
  id: 'b3', brn: 'TALLOST', instructions: [{ instructionNo: '555555555', qty: 2 }], createdAt: now, updatedAt: now, history: [],
  units: ['RRN-L1', 'RRN-L2'].map((rrn) => ({ rrn, instructionNo: '555555555', status: 'receipted_bsc' as const, statusAt: now, history: [] })),
};
u = applyUnitScans([lost], st('collect_bsc'), [
  { instructionNo: '555555555', rrn: '', noRrn: true, description: 'label gone' }, { instructionNo: '', rrn: 'RRN-L1' },
], actor, now);
assert.ok(u.ok, u.errors.join('; '));
assert.deepEqual(u.moved.map((m) => m.unit.rrn), ['RRN-L1', 'RRN-L2']);
assert.match(u.moved[1].unit.history.at(-1)!.note!, /taken as RRN-L2/);
assert.equal(talStage('receipt_repaired')!.key, 'collect_bsc', 'old bookmark opens the step that does the work');

console.log('test-tal: all checks passed');
