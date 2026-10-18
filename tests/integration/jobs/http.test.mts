import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {transaction} from '../../../apps/web/src/server/platform/database.ts';
import {executorHandler} from '../../../apps/web/src/server/jobs/http.ts';
import {enqueueJob} from '../../../apps/web/src/server/jobs/queue.ts';
import {db,runtime,tenant,setup,teardown,subject} from './support.mts';
before(setup);after(teardown);
test('INV-executor: missing or wrong credentials and arbitrary job parameters cannot dispatch; invocation budget leaves owed jobs',async()=>{
 for(let n=0;n<3;n++){const id=await subject();await transaction(runtime,tx=>enqueueJob(tx,{tenant,kind:'document_render',subject:id,key:id,revision:'1',eligibleAt:'2026-01-01T00:00:00Z'}));}
 let calls=0;
 const handler=executorHandler({db:runtime,secret:'s'.repeat(40),limit:2,handlers:{document_render:async()=>{calls++;return {state:'succeeded'};}},publish:async()=>true});
 const request=(key,body)=>new Request('http://example.test/executor',{method:'POST',body,headers:key?{authorization:'Bearer '+key}:{}});
 assert.equal((await handler(request(null))).status,404);
 assert.equal((await handler(request('wrong'))).status,404);
 assert.equal((await executorHandler({db:runtime,secret:'',handlers:{document_render:async()=>({state:'succeeded'})},publish:async()=>true})(request('s'.repeat(40)))).status,404);
 assert.equal((await handler(request('s'.repeat(40),JSON.stringify({kind:'lifecycle_purge'})))).status,413);
 assert.equal(calls,0);
 const response=await handler(request('s'.repeat(40)));assert.equal(response.status,200);assert.deepEqual(await response.json(),{processed:2});assert.equal(calls,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM job WHERE state='ready'")).rows[0].n,1);
});
