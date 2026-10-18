import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {createMailService} from '../../../apps/web/src/server/jobs/mail.ts';
import {createResendTransport} from '../../../apps/web/src/server/jobs/resend.ts';
import {claimDue} from '../../../apps/web/src/server/jobs/queue.ts';
const require=createRequire(new URL('../../../apps/web/package.json',import.meta.url));const {Pool}=require('pg');
const url=new URL(process.env.JOBS_TEST_CONNECTION??'about:blank');
if(url.hostname!=='ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech'||process.env.NODE_ENV==='production')throw Error('test_database_required');
const endpoint=new URL(process.env.JOBS_TEST_ENDPOINT??'about:blank');if(endpoint.hostname!=='127.0.0.1')throw Error('local_provider_required');
const db=new Pool({connectionString:url.href,options:process.env.JOBS_TEST_OPTIONS,max:2});
const service=createMailService({db,encryptionKey:Buffer.from(process.env.JOBS_TEST_KEY??'','base64'),addressKey:randomBytes(32),from:'no-reply@example.test',
 authorize:async(tx,m)=>(await tx.query('SELECT id FROM seat WHERE account_id=$1 AND plant_id=$2 AND ended_at IS NULL FOR SHARE',[m.recipient,m.tenant])).rowCount===1,
 transport:createResendTransport('synthetic',async(url,init)=>fetch(endpoint.origin+new URL(url).pathname,init))});
try{const [claim]=await claimDue(db,['mail']);if(!claim)throw Error('claim_required');await service.dispatch(claim);}finally{await db.end();}
