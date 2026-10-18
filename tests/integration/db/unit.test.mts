import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTimeZone } from '../../../packages/db/src/schema/time.ts';
import { revision } from '../../../packages/contracts/src/common/values.ts';

test('INV-calendar: stored canonical spelling resolves aliases without changing a saved instant',()=>{
  assert.equal(canonicalTimeZone('US/Eastern'),'America/New_York');
  assert.equal(canonicalTimeZone('Etc/UTC'),'UTC');
  assert.equal(canonicalTimeZone('America/Chicago'),'America/Chicago');
  for(const zone of ['+04:00','not/a-zone','Etc/GMT+5']) assert.throws(()=>canonicalTimeZone(zone));
});
test('INV-revision: PostgreSQL int64 upper bound survives the shared decimal-string boundary',()=>{
  assert.equal(revision.parse('9223372036854775807'),'9223372036854775807');
  assert.equal(revision.safeParse('9223372036854775808').success,false);
  assert.equal(revision.safeParse(9223372036854775807n).success,false);
});
