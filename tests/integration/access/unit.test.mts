import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAdmission, safeReturn } from '../../../packages/domain/src/access/security.ts';

test('INV-boundary: canonical origin/host/method admission and exact independently authenticated exceptions; safe local returns', async () => {
  const origin = 'https://everyfield.test';
  const admission = requestAdmission({ origin, host: 'everyfield.test', browserMutations: [{ path: '/api/person', methods: ['POST'] }],
    exceptions: [{ kind: 'resend_raw_signature', path: '/api/resend', method: 'POST', async verify(request) { return request.headers.get('signature') === 'synthetic-valid-signature' && await request.text() === 'raw-provider-bytes'; } }] });
  const req = (path, method, headers = {}, body) => new Request(origin + path, { method, headers: { host: 'everyfield.test', ...headers }, ...(body ? { body } : {}) });
  assert.equal(await admission(req('/api/person', 'POST', { origin })), true);
  for (const headers of [{}, { origin: 'null' }, { origin: origin + ':444' }, { origin: 'https://foreign.test' }, { origin, host: 'foreign.test' }, { origin: 'https://foreign.test', 'x-forwarded-host': 'everyfield.test' }]) assert.equal(await admission(req('/api/person', 'POST', headers)), false);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) assert.equal(await admission(req('/api/person', method, { origin })), false);
  const provider = req('/api/resend', 'POST', { signature: 'synthetic-valid-signature' }, 'raw-provider-bytes');
  assert.equal(await admission(provider), true);
  assert.equal(await provider.text(), 'raw-provider-bytes');
  assert.equal(await admission(req('/api/resend/forged', 'POST', { signature: 'synthetic-valid-signature' }, 'raw-provider-bytes')), false);
  assert.equal(await admission(req('/api/resend', 'POST', { signature: 'wrong' }, 'raw-provider-bytes')), false);
  assert.equal(await admission(req('/api/resend', 'GET', { signature: 'synthetic-valid-signature' })), false);
  assert.equal(safeReturn('/people?sort=name'), '/people?sort=name');
  for (const path of ['https://foreign.test', '//foreign.test', '/%255cforeign', '/%250aheader', '/\\foreign']) assert.equal(safeReturn(path), null);
});
