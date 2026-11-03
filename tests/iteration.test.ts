import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { TaskState } from '@a2a-js/sdk';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import type { PaymentPayload } from '@x402/core/types';
import { createService } from '../apps/server/src/service.js';
import { createPaymentGate, publicTask, type TaskRecord } from '../apps/server/src/payment-gate.js';
import { runExperiment, SAMPLE_TASK } from '../apps/client/src/agent1.js';
import { createTools, Unresolved } from '../apps/client/src/tools.js';
import { deployment, artifact, chainClient, assertDeployment } from '../packages/shared/src/local.js';
import { digest } from '../packages/shared/src/store.js';
import { EXTENSION, requirements } from '../packages/shared/src/card.js';
import { lookupAgent } from '../packages/shared/src/registry.js';
import { publicData, type RunRecord } from '../packages/experiment/src/events.js';
import { validateAssessment, executeSpecialist } from '../packages/llm/src/runtime.js';
import type { Model, ChatMessage } from '../packages/llm/src/provider.js';
const assessment = { summary: 'Managed meets the deadline.', tradeoffs: ['Less customization for faster launch.'], risks: ['Vendor dependence.'], limitations: ['Maintenance cost is not quantified.'] };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeout = 10000) { const end = Date.now()+timeout; while (Date.now()<end) { if (await fn()) return; await delay(20); } throw new Error('Test condition timed out'); }
function coordinator(): Model {
  const names = ['lookup_agent_card','request_agent','verify_payment_challenge','sign_payment','retry_with_payment']; let index = 0;
  return { id: 'controlled-coordinator', async complete(messages: ChatMessage[]) {
    if (index < names.length) { const name = names[index++]; return { message: { role: 'assistant', content: null, tool_calls: [{ id: String(index), type: 'function', function: { name, arguments: JSON.stringify(name === 'request_agent' ? { task: SAMPLE_TASK } : {}) } }] } }; }
    const result = JSON.parse(messages.at(-1)!.content!); assert.deepEqual(result.assessment, assessment); assert.equal(result.receiptVerified, true);
    return { message: { role: 'assistant', content: 'Choose managed: the specialist found that it meets the deadline, with vendor dependence as a risk.' } };
  } };
}
test('paid A2A lifecycle on an isolated local blockchain', { timeout: 150000 }, async t => {
  const root = process.cwd(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate1-test-')); const children: ChildProcess[] = []; let server: Server | undefined;
  fs.cpSync(path.join(root, 'artifacts'), path.join(tmp, 'artifacts'), { recursive: true });
  const env = { ...process.env, RPC_URL: 'http://127.0.0.1:18545' }; process.env.RPC_URL = env.RPC_URL;
  function child(args: string[], cwd: string) { const p=spawn(process.execPath,args,{cwd,env,stdio:['ignore','ignore','pipe']});p.stderr?.on('data', b => process.stderr.write(b));children.push(p);return p; }
  async function fixture() { const p=child(['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'scripts/fixture.mjs')],tmp); await new Promise<void>((resolve,reject)=>{p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(new Error(`Fixture exited ${c}`)));}); }
  async function start(options: Parameters<typeof createService>[0]) { const svc=await createService(options); server=await new Promise<Server>(resolve=>{const s=svc.app.listen(4021,'127.0.0.1',()=>resolve(s));});return svc; }
  async function close() { if(server) await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));server=undefined; }
  try {
    child([path.join(root,'node_modules/hardhat/dist/src/cli.js'),'node','--hostname','127.0.0.1','--port','18545'],root);
    await until(async()=>{try {const r=await fetch(env.RPC_URL!,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});return r.ok;}catch{return false;}},20000);
    const checkpoint=await (await fetch(env.RPC_URL!,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'evm_snapshot',params:[]})})).json();
    await fixture(); process.chdir(tmp);
    child(['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'scripts/facilitator.mjs')],tmp);
    await until(async()=>{try{return (await fetch('http://127.0.0.1:4022/health')).ok;}catch{return false;}},20000);
    const d=deployment(); const chain=chainClient(d);
    const balances=async()=>Promise.all([d.client,d.agentCard].map(address=>chain.readContract({address:d.token,abi:artifact('TestUSD').abi,functionName:'balanceOf',args:[address]})));
    const proof=async()=>{const a=privateKeyToAccount(JSON.parse(fs.readFileSync('runtime/client-key.json','utf8')).privateKey);const terms=requirements(d);const p=await new ExactEvmScheme(toClientEvmSigner(a)).createPaymentPayload(2,terms);return {x402Version:2,accepted:terms,payload:p.payload} as PaymentPayload;};
    const body=(id=crypto.randomUUID())=>({jsonrpc:'2.0',id:crypto.randomUUID(),method:'SendMessage',params:{message:{messageId:id,role:'ROLE_USER',parts:[{data:{task:SAMPLE_TASK},mediaType:'application/json'}]},configuration:{returnImmediately:true,historyLength:0}}});
    const credential=()=>crypto.randomBytes(32).toString('hex');
    await t.test('dashboard card is read only and matches on-chain discovery',async()=>{
      await start({file:'runtime/test-card.json'});
      const base='http://127.0.0.1:14030';
      const dashboard=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'apps/dashboard/src/index.ts')],{cwd:tmp,env:{...env,DASHBOARD_PORT:'14030'},stdio:'ignore'});children.push(dashboard);
      try {
        await until(async()=>{try{return (await fetch(base+'/api/session')).ok;}catch{return false;}},20000);
        const original=await(await fetch(base+'/api/card')).json();
        const session=await(await fetch(base+'/api/session')).json();
        const found=await lookupAgent(d);
        assert.deepEqual(original.card,found.card);assert.equal(original.hash,found.provenance.cardHash);
        assert.equal((await(await fetch('http://127.0.0.1:4021/.well-known/agent-card.json')).json()).name,original.card.name);
        const response=await fetch(base+'/api/card',{method:'PUT',headers:{'content-type':'application/json',origin:base,'x-session-token':session.token},body:JSON.stringify({hash:original.hash,advertisement:{name:'Changed'}})});
        assert.equal(response.status,404);
        assert.equal((await lookupAgent(d)).provenance.cardHash,original.hash);
      } finally { dashboard.kill('SIGTERM');await new Promise<void>(resolve=>dashboard.once('exit',()=>resolve()));await close(); }
    });
    async function rpc(b: unknown,c: string,p?: PaymentPayload) {return fetch('http://127.0.0.1:4021/',{method:'POST',headers:{'content-type':'application/json','a2a-version':'1.0','a2a-extensions':EXTENSION,'x-task-access':c,...(p?{'payment-signature':encodePaymentSignatureHeader(p)}:{})},body:JSON.stringify(b)});}
    await t.test('controlled models exercise real discovery, signing, SDK SendMessage/GetTask, settlement, final incorporation',async()=>{
      const svc=await start({file:'runtime/test-success.json',execute:async(req,run)=>executeSpecialist(req,run,{id:'controlled-specialist',async complete(){return {message:{role:'assistant',content:JSON.stringify(assessment)}};}})});
      const before=await balances(); const run=await runExperiment(SAMPLE_TASK,crypto.randomUUID(),coordinator(),{pollMs:25});
      assert.equal(run.status,'completed',run.error ?? 'Run did not complete'); assert.equal(run.mode,'controlled-test');assert.ok(run.taskId);assert.ok(run.transaction);assert.deepEqual(run.assessment,assessment);assert.equal(svc.getExecutions(),1);
      const after=await balances(); assert.equal(BigInt(String(before[0]))-BigInt(String(after[0])),2000000n);assert.equal(BigInt(String(after[1]))-BigInt(String(before[1])),2000000n);
      await close();
    });
    await t.test('private staging, duplicate binding, read authentication and one settlement',async()=>{
      let releaseExecution!:()=>void,releaseSettlement!:()=>void;const execution=new Promise<void>(r=>releaseExecution=r),settlement=new Promise<void>(r=>releaseSettlement=r);let settlements=0;
      const svc=await start({file:'runtime/test-staging.json',execute:async()=>{await execution;return assessment;},facilitator:async<T>(route:string,p:PaymentPayload)=>{
        if(route==='settle'){settlements++;await settlement;}
        const r=await fetch(`http://127.0.0.1:4022/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x402Version:2,paymentPayload:p,paymentRequirements:requirements(d)})});return r.json() as Promise<T>;
      }});
      const p=await proof(),c=credential(),b=body();const before=await balances();
      assert.equal((await rpc(b,c)).status,402);assert.equal(svc.getExecutions(),0);
      const ack=await (await rpc(b,c,p)).json(); assert.ok(ack.result?.task?.id,JSON.stringify(ack));const id=ack.result.task.id;
      await until(()=>svc.getExecutions()===1);
      const record=svc.gate.store.state.tasks[id];assert.equal(record.phase,'executing');assert.equal(settlements,0);
      assert.equal((await rpc(b,c,p)).status,200);assert.equal(svc.getExecutions(),1);
      assert.equal((await rpc(body(),c,p)).status,409);
      assert.equal((await rpc({...b,params:{...b.params,message:{...b.params.message,parts:[{data:{task:'Different request content'}}]}}},c,p)).status,409);
      const get={jsonrpc:'2.0',id:'poll',method:'GetTask',params:{id,historyLength:0}};
      assert.equal((await rpc(get,credential())).status,404);
      releaseExecution();await until(()=>record.phase==='settling');assert.equal(settlements,1);assert.deepEqual(await balances(),before);
      for(let i=0;i<3;i++){const r=await rpc(get,c);const text=await r.text();assert.ok(!text.includes(assessment.summary));assert.equal(r.headers.get('payment-response'),null);assert.equal(svc.getExecutions(),1);}
      assert.equal(JSON.stringify(publicTask(record)).includes(assessment.summary),false);
      releaseSettlement();await until(()=>record.phase==='delivered');const completed=await rpc(get,c);assert.ok(completed.headers.has('payment-response'));assert.ok((await completed.text()).includes(assessment.summary));assert.equal(settlements,1);
      await rpc(b,c,p);assert.equal(settlements,1);assert.equal(svc.getExecutions(),1);await close();
    });
    await t.test('execution failure leaves authorization unused and balances unchanged',async()=>{
      let settlements=0;const svc=await start({file:'runtime/test-failure.json',execute:async()=>{throw new Error('cannot execute');},facilitator:async<T>(route:string,p:PaymentPayload)=>{
        if(route==='settle')settlements++;const r=await fetch(`http://127.0.0.1:4022/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x402Version:2,paymentPayload:p,paymentRequirements:requirements(d)})});return r.json() as Promise<T>;
      }});const before=await balances(),p=await proof();await rpc(body(),credential(),p);await until(()=>Object.values(svc.gate.store.state.tasks)[0]?.phase==='execution-failed');assert.equal(settlements,0);assert.deepEqual(await balances(),before);
      const auth=p.payload.authorization as any;assert.equal(await chain.readContract({address:d.token,abi:artifact('TestUSD').abi,functionName:'authorizationState',args:[auth.from,auth.nonce]}),false);await close();
    });
    await t.test('invalid proof cannot execute, restart never resumes private staged work',async()=>{
      const svc=await start({file:'runtime/test-invalid.json',execute:async()=>{throw new Error('must not execute');}});const p=await proof();p.payload.signature='0x'+ '00'.repeat(65);const r=await rpc(body(),credential(),p);assert.notEqual(r.status,200);assert.equal(svc.getExecutions(),0);await close();
      const gate=createPaymentGate(d,{file:'runtime/restart.json'});const rec:TaskRecord={id:'interrupted',contextId:'ctx',runId:'run',messageId:'message',bodyHash:'body',proofHash:'proof',credentialHash:'credential',authKey:'auth',payer:d.client,nonce:'0x00',phase:'settling',state:TaskState.TASK_STATE_WORKING,updatedAt:new Date().toISOString(),stagedResult:assessment};gate.store.state.tasks[rec.id]=rec;gate.store.save();
      const restarted=createPaymentGate(d,{file:'runtime/restart.json',execute:async()=>{throw new Error('must not resume');}});assert.equal(restarted.store.state.tasks.interrupted.phase,'unresolved');assert.equal(restarted.getExecutions(),0);assert.ok(!JSON.stringify(restarted.getTask('interrupted')).includes(assessment.summary));
    });
    await t.test('polling interruption stays unresolved and signing cannot repeat',async()=>{
      let finish!:()=>void;const hold=new Promise<void>(r=>finish=r);const svc=await start({file:'runtime/test-timeout.json',execute:async()=>{await hold;throw new Error('stopped');}});
      const r:RunRecord={id:crypto.randomUUID(),task:SAMPLE_TASK,status:'running',mode:'controlled-test',startedAt:new Date().toISOString()};const tools=createTools(r,()=>{},{pollMs:10,deadlineMs:70});
      await tools.invoke('lookup_agent_card',{});await tools.invoke('request_agent',{task:SAMPLE_TASK});await tools.invoke('verify_payment_challenge',{});await tools.invoke('sign_payment',{});await assert.rejects(()=>tools.invoke('retry_with_payment',{}),Unresolved);await assert.rejects(()=>tools.invoke('sign_payment',{}),/phase/);assert.equal(svc.getExecutions(),1);finish();await until(()=>Object.values(svc.gate.store.state.tasks)[0]?.phase==='execution-failed');await close();
    });
    await t.test('settlement transport loss is unresolved, never retried or delivered',async()=>{
      let settlements=0;const svc=await start({file:'runtime/test-settle-loss.json',execute:async()=>assessment,facilitator:async<T>(route:string,p:PaymentPayload)=>{
        if(route==='settle'){settlements++;throw new Error('response lost');}
        const r=await fetch('http://127.0.0.1:4022/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x402Version:2,paymentPayload:p,paymentRequirements:requirements(d)})});return r.json() as Promise<T>;
      }});const b=body(),c=credential(),p=await proof();await rpc(b,c,p);await until(()=>Object.values(svc.gate.store.state.tasks)[0]?.phase==='unresolved');const record=Object.values(svc.gate.store.state.tasks)[0];
      await rpc(b,c,p);assert.equal(settlements,1);assert.equal(record.state,TaskState.TASK_STATE_UNSPECIFIED);assert.ok(!JSON.stringify(publicTask(record)).includes(assessment.summary));await close();
    });
    await t.test('malformed specialist output and insufficient lifetime cannot settle',async()=>{
      let settlements=0;const svc=await start({file:'runtime/test-malformed.json',execute:async(req,run)=>executeSpecialist(req,run,{id:'controlled-invalid',async complete(){return {message:{role:'assistant',content:'not JSON'}};}}),facilitator:async<T>(route:string,p:PaymentPayload)=>{
        if(route==='settle')settlements++;const r=await fetch(`http://127.0.0.1:4022/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x402Version:2,paymentPayload:p,paymentRequirements:requirements(d)})});return r.json() as Promise<T>;
      }});const p=await proof();const expired=structuredClone(p);(expired.payload.authorization as any).validBefore=String(Math.floor(Date.now()/1000)+10);assert.equal((await rpc(body(),credential(),expired)).status,400);assert.equal(svc.getExecutions(),0);
      await rpc(body(),credential(),p);await until(()=>Object.values(svc.gate.store.state.tasks)[0]?.phase==='execution-failed');assert.equal(settlements,0);await close();
    });
    await t.test('chain reset detection and authenticated task reads fail closed',async()=>{const svc=await start({file:'runtime/restart.json'});const c=credential();svc.gate.store.state.tasks.interrupted.credentialHash=digest(c);svc.gate.store.save();const get={jsonrpc:'2.0',id:'poll',method:'GetTask',params:{id:'interrupted'}};assert.equal((await rpc(get,c)).status,200);await chain.request({method:'evm_revert' as any,params:[checkpoint.result]} as any);await assert.rejects(()=>assertDeployment(d),/missing|Stale/);assert.equal((await rpc(get,c)).status,503);assert.equal(svc.getExecutions(),0);await close();});
  } finally { await close(); for(const p of children.reverse())p.kill('SIGTERM');await Promise.all(children.map(p=>p.exitCode!==null||p.signalCode!==null?Promise.resolve():new Promise<void>(r=>p.once('exit',()=>r()))));process.chdir(root);fs.rmSync(tmp,{recursive:true,force:true}); }
});
test('output validation and public event redaction reject malformed/leaking content',()=>{
  assert.throws(()=>validateAssessment({...assessment,risks:[]}));assert.throws(()=>validateAssessment({...assessment,summary:''}));
  const safe=publicData({signature:'0xabc',api_key:'key',credential:'private',stagedResult:assessment,receipt:{transaction:'0x123'},text:'0x'+'ab'.repeat(65)});assert.deepEqual(safe,{receipt:{transaction:'0x123'},text:'[signature omitted]'});
});
