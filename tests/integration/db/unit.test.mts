import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTimeZone } from '../../../packages/db/src/schema/time.ts';

test('INV-calendar: stored canonical spelling resolves aliases without changing a saved instant',()=>{
  assert.equal(canonicalTimeZone('US/Eastern'),'America/New_York');
  assert.equal(canonicalTimeZone('Etc/UTC'),'UTC');
  assert.equal(canonicalTimeZone('America/Chicago'),'America/Chicago');
  for(const zone of ['+04:00','not/a-zone','Etc/GMT+5']) assert.throws(()=>canonicalTimeZone(zone));
});
