const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distributeConsumptionAcrossUnits } = require('../src/utils/stockLots');

// Regression coverage for the real bug found in manufacturing.js: per-unit
// mfg_assembly_items traceability used to re-query and grab "the oldest lot
// with any history" instead of using consumeStockFIFO's ACTUAL result — so a
// component split across multiple lots never got more than one row, and the
// row could point at a lot that wasn't really drawn from at all.

test('single lot fully covers every unit — one row per unit', () => {
  const consumed = [{ lotId: 'L1', quantityConsumed: 6, unitCost: 10 }];
  const result = distributeConsumptionAcrossUnits(consumed, 2, 3);
  assert.deepEqual(result, [
    [{ lotId: 'L1', quantity: 2 }],
    [{ lotId: 'L1', quantity: 2 }],
    [{ lotId: 'L1', quantity: 2 }],
  ]);
});

test('a unit whose share straddles a lot boundary gets two rows', () => {
  // 3 units x 5 each = 15 needed; lot L1 has 8, lot L2 has 7 (consumeStockFIFO's real order).
  const consumed = [
    { lotId: 'L1', quantityConsumed: 8, unitCost: 10 },
    { lotId: 'L2', quantityConsumed: 7, unitCost: 12 },
  ];
  const result = distributeConsumptionAcrossUnits(consumed, 5, 3);
  assert.deepEqual(result, [
    [{ lotId: 'L1', quantity: 5 }],                                // unit 0: fully from L1 (3 left in L1)
    [{ lotId: 'L1', quantity: 3 }, { lotId: 'L2', quantity: 2 }],  // unit 1: drains L1, then L2
    [{ lotId: 'L2', quantity: 5 }],                                 // unit 2: fully from L2
  ]);

  // Sanity: every lot's total allocated across units matches what was actually consumed from it.
  const totalsByLot = {};
  for (const unitRows of result) {
    for (const { lotId, quantity } of unitRows) totalsByLot[lotId] = (totalsByLot[lotId] || 0) + quantity;
  }
  assert.equal(totalsByLot.L1, 8);
  assert.equal(totalsByLot.L2, 7);
});

test('three or more lots touched by a single unit are all recorded', () => {
  // One unit needs 10; three tiny lots of 4, 3, 5 (only 10 of the 12 gets used by this single unit).
  const consumed = [
    { lotId: 'L1', quantityConsumed: 4, unitCost: 1 },
    { lotId: 'L2', quantityConsumed: 3, unitCost: 1 },
    { lotId: 'L3', quantityConsumed: 3, unitCost: 1 }, // only 3 of L3 actually consumed for this need
  ];
  const result = distributeConsumptionAcrossUnits(consumed, 10, 1);
  assert.deepEqual(result, [
    [{ lotId: 'L1', quantity: 4 }, { lotId: 'L2', quantity: 3 }, { lotId: 'L3', quantity: 3 }],
  ]);
});

test('zero units requested returns an empty array', () => {
  const result = distributeConsumptionAcrossUnits([{ lotId: 'L1', quantityConsumed: 5, unitCost: 1 }], 5, 0);
  assert.deepEqual(result, []);
});

test('fractional quantities split cleanly across units', () => {
  const consumed = [{ lotId: 'L1', quantityConsumed: 3, unitCost: 1 }];
  const result = distributeConsumptionAcrossUnits(consumed, 1.5, 2);
  assert.deepEqual(result, [
    [{ lotId: 'L1', quantity: 1.5 }],
    [{ lotId: 'L1', quantity: 1.5 }],
  ]);
});

test('terminates without hanging when consumed is shorter than required (precondition violated)', () => {
  // Should never happen in practice (consumeStockFIFO already throws first if
  // total stock is insufficient), but must not infinite-loop defensively.
  const result = distributeConsumptionAcrossUnits([], 5, 2);
  assert.deepEqual(result, [[], []]);
});
