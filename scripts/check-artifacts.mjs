import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const secrets=['client','facilitator'].map(role=>{const p=`runtime/${role}-key.json`;assert.equal(fs.statSync(p).mode&0o077,0);return JSON.parse(fs.readFileSync(p,'utf8')).privateKey;});
if(fs.existsSync('.env')){assert.equal(fs.statSync('.env').mode&0o077,0);for(const line of fs.readFileSync('.env','utf8').split('\n')){const m=line.match(/^(?:NVIDIA_API_KEY|LLM_API_KEY|OPENAI_API_KEY)=(.+)$/);if(m?.[1]?.trim())secrets.push(m[1].trim().replace(/^['"]|['"]$/g,''));}}
let checked=0;
function inspect(p){if(!fs.existsSync(p))return;if(fs.statSync(p).isDirectory()){for(const f of fs.readdirSync(p))inspect(path.join(p,f));return;}const b=fs.readFileSync(p);for(const secret of secrets)assert.ok(!b.includes(Buffer.from(secret)),`Secret leaked into ${p}`);checked++;}
['apps','packages','scripts','contracts','tests','evidence','deployments','.env.example','README.md','IMPLEMENTATION.md','proposal.md'].forEach(inspect);
console.log(JSON.stringify({passed:true,filesChecked:checked,keysRestricted:true,noKeyLeak:true}));
