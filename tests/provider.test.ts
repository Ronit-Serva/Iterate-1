import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModel, modelConfig } from '../packages/llm/src/provider.js';
test('compatible model adapter transmits real tools, samples, bounds output and fails on truncation',async()=>{
  const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'iterate1-provider-'));const old={...process.env};let finish='tool_calls';let seen:any;
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen=JSON.parse(body);assert.equal(req.url,'/v1/chat/completions');res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:finish,message:{role:'assistant',content:null,reasoning_content:'PRIVATE MUST NOT BE LOGGED',tool_calls:[{id:'call1',type:'function',function:{name:'lookup_agent_card',arguments:'{}'}}]}}],usage:{total_tokens:10}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{process.chdir(tmp);process.env.LLM_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/v1`;process.env.LLM_MODEL='controlled-adapter-model';delete process.env.AGENT1_MODEL;process.env.LLM_MAX_TOKENS='2400';process.env.LLM_REASONING_EFFORT='none';process.env.LLM_API_KEY='test-only-key';
    const model=createModel('agent1','test-adapter');const tools=[{type:'function' as const,function:{name:'lookup_agent_card',description:'Discover',parameters:{type:'object',properties:{}}}}];
    const reply=await model.complete([{role:'user',content:'Discover the specialist'}],tools);assert.equal(reply.message.tool_calls?.[0].function.name,'lookup_agent_card');assert.equal(seen.temperature,1);assert.equal(seen.top_p,0.95);assert.equal(seen.max_tokens,2400);assert.equal(seen.parallel_tool_calls,false);assert.deepEqual(seen.tools,tools);assert.equal('reasoning_content' in reply.message,false);
    assert.equal(seen.reasoning_effort,'none');
    finish='length';await assert.rejects(()=>model.complete([reply.message,{role:'tool',tool_call_id:'call1',content:'{}'}]),/truncated/);
    assert.equal(seen.messages[0].reasoning_content,'PRIVATE MUST NOT BE LOGGED');
    assert.equal('reasoning_content' in reply.message,false);
    const journal=fs.readFileSync(`runtime/events/${process.pid}.jsonl`,'utf8');assert.ok(!journal.includes('PRIVATE MUST NOT BE LOGGED'));assert.ok(!journal.includes('test-only-key'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));process.chdir(root);process.env=old;fs.rmSync(tmp,{recursive:true,force:true});}
});

test('NVIDIA Mistral validates model-specific reasoning modes before network access',()=>{
  const old={...process.env};
  try{
    process.env.LLM_BASE_URL='https://integrate.api.nvidia.com/v1';process.env.LLM_MODEL='mistralai/mistral-large-4-1t-a52b';delete process.env.AGENT1_MODEL;delete process.env.LLM_REASONING_EFFORT;
    assert.equal(modelConfig('agent1').reasoning,'none');
    for(const effort of ['none','high']){process.env.LLM_REASONING_EFFORT=effort;assert.equal(modelConfig('agent1').reasoning,effort);}
    for(const effort of ['low','medium']){process.env.LLM_REASONING_EFFORT=effort;assert.throws(()=>modelConfig('agent1'),/supports.*none or high/);}
  }finally{process.env=old;}
});

test('provider parameter rejection emits actionable diagnostics without provider-body secrets',async()=>{
  const old={...process.env},root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'iterate1-provider-error-'));
  const server=http.createServer((_req,res)=>{res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:'PRIVATE PROVIDER BODY MUST NOT APPEAR'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{process.chdir(tmp);process.env.LLM_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/v1`;process.env.LLM_MODEL='controlled-error-model';delete process.env.AGENT1_MODEL;delete process.env.LLM_REASONING_EFFORT;
    await assert.rejects(()=>createModel('agent1','test-422').complete([{role:'user',content:'test'}]),/HTTP 422: request parameters rejected/);
    const journal=fs.readFileSync(`runtime/events/${process.pid}.jsonl`,'utf8');assert.ok(journal.includes('model-error'));assert.ok(journal.includes('422'));assert.ok(!journal.includes('PRIVATE PROVIDER BODY'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));process.chdir(root);process.env=old;fs.rmSync(tmp,{recursive:true,force:true});}
});

test('Nemotron Lightning uses bounded reasoning rather than a Mistral effort value',()=>{
  const old={...process.env};
  try{process.env.LLM_BASE_URL='https://integrate.api.nvidia.com/v1';process.env.LLM_MODEL='nvidia/nemotron-3.5-lightning-30b-a3b';delete process.env.AGENT1_MODEL;delete process.env.LLM_REASONING_EFFORT;delete process.env.LLM_REASONING_BUDGET;process.env.LLM_MAX_TOKENS='4096';
    const config=modelConfig('agent1');assert.equal(config.reasoning,undefined);assert.equal(config.reasoningBudget,128);
    process.env.LLM_REASONING_BUDGET='256';assert.equal(modelConfig('agent1').reasoningBudget,256);
    for(const value of ['-1','4096','bad']){process.env.LLM_REASONING_BUDGET=value;assert.throws(()=>modelConfig('agent1'),/BUDGET/);}
    process.env.LLM_REASONING_BUDGET='128';process.env.LLM_REASONING_EFFORT='none';assert.throws(()=>modelConfig('agent1'),/leave LLM_REASONING_EFFORT empty/);
  }finally{process.env=old;}
});
