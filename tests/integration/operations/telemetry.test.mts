import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTelemetry, telemetryConfig } from '../../../packages/domain/src/operations/telemetry.ts';
test('AC:CASE-OPS-003 telemetry emits only closed content-free fields, bounds outages and never falls back',async()=>{
  const bodies=[],headers=[];
  let hang=false;
  const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);bodies.push(JSON.parse(Buffer.concat(chunks).toString()));headers.push(req.headers);if(!hang)res.end('ok');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}/trace`;
  try{
    const token=randomBytes(32).toString('hex');
    const t=createTelemetry(telemetryConfig({endpoint,token,timeoutMs:40}));
    const value={kind:'operation',operation:'jobs.tickNotifications',correlation:randomUUID(),build:'a'.repeat(40),status:'ok',duration_ms:4};
    assert.equal(t.record(value),true);
    for(const extra of ['private_note','prompt','headers','email','period','nudge_count','file_bytes','metadata'])assert.equal(t.record({...value,[extra]:'CARE-CANARY'}),false);
    assert.equal(t.record({...value,operation:'privateCare.read'}),false);
    assert.equal(await t.flush(),'sent');
    assert.deepEqual(bodies,[{observations:[value]}]);assert.equal(headers[0].authorization,`Bearer ${token}`);
    hang=true;assert.equal(t.record({...value,kind:'error',status:'failed'}),true);
    const started=performance.now();assert.equal(await t.flush(),'unavailable');assert.ok(performance.now()-started<800);
    for(const url of ['http://example.test/trace','https://a:b@example.test/trace','https://example.test/trace?token=x','https://example.test/trace#x','file:///tmp/a'])assert.throws(()=>telemetryConfig({endpoint:url,token}));
    assert.throws(()=>telemetryConfig({endpoint,token,NEXT_PUBLIC_TRACE_SECRET:token}));
    assert.equal(await createTelemetry(null).flush(),'disabled');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

