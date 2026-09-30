import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, toLocalDateInput } from '../src/utils.js';
test('month navigation clamps month-end dates, including leap years',()=>{
 assert.equal(toLocalDateInput(addMonths(new Date(2026,0,31),1)),'2026-02-28');
 assert.equal(toLocalDateInput(addMonths(new Date(2024,0,31),1)),'2024-02-29');
 assert.equal(toLocalDateInput(addMonths(new Date(2026,2,31),-1)),'2026-02-28');
});
