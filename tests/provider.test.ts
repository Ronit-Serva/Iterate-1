import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModel } from '../packages/llm/src/provider.js';
test('compatible model adapter transmits real tools, samples, bounds output and fails on truncation',async()=>{
  const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'iterate1-provider-'));const old={...process.env};let finish='tool_calls';let seen:any;
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen=JSON.parse(body);assert.equal(req.url,'/v1/chat/completions');res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:finish,message:{role:'assistant',content:null,reasoning_content:'PRIVATE MUST NOT BE LOGGED',tool_calls:[{id:'call1',type:'function',function:{name:'lookup_agent_card',arguments:'{}'}}]}}],usage:{total_tokens:10}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{process.chdir(tmp);process.env.LLM_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/v1`;process.env.LLM_MODEL='controlled-adapter-model';process.env.LLM_API_KEY='test-only-key';
    const model=createModel('agent1','test-adapter');const tools=[{type:'function' as const,function:{name:'lookup_agent_card',description:'Discover',parameters:{type:'object',properties:{}}}}];
    const reply=await model.complete([{role:'user',content:'Discover the specialist'}],tools);assert.equal(reply.message.tool_calls?.[0].function.name,'lookup_agent_card');assert.equal(seen.temperature,1);assert.equal(seen.top_p,0.95);assert.equal(seen.max_tokens,2400);assert.equal(seen.parallel_tool_calls,false);assert.deepEqual(seen.tools,tools);assert.equal('reasoning_content' in reply.message,false);
    finish='length';await assert.rejects(()=>model.complete([{role:'user',content:'Test'}]),/truncated/);
    const journal=fs.readFileSync(`runtime/events/${process.pid}.jsonl`,'utf8');assert.ok(!journal.includes('PRIVATE MUST NOT BE LOGGED'));assert.ok(!journal.includes('test-only-key'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));process.chdir(root);process.env=old;fs.rmSync(tmp,{recursive:true,force:true});}
});
