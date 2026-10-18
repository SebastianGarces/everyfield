import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStarter, verifyCheckout } from '../../../packages/reference/src/starter.ts';

// Existing owned acceptance cases were checked before this cases-first commit.
test('AC:GAP-REF-001 AC:REF-CASE-001 exact original Playbook survives packaging', async () => {
  const starter = await loadStarter();
  const source = starter.sources.find(s => s.path === 'docs/reference/playbook.md');
  assert.equal(source?.sha256, 'd365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a');
  assert.equal(Buffer.byteLength(source!.body), 34025);
  assert.equal((await verifyCheckout(new URL('../../../', import.meta.url))).ok, true);
});
