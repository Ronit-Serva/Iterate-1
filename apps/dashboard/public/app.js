const $ = id => document.getElementById(id);
let session, snapshot, selected, selectedEvent;
async function loadCard() {
 $('card-location').textContent='Loading the card from the local chain…';
 $('card-message').textContent='';
 try {
  const response=await fetch('/api/card',{signal:AbortSignal.timeout(8000)});
  if(response.status===404)throw new Error('The running dashboard backend predates the card viewer. Restart the dashboard backend to enable on-chain lookup. You can open the server’s published card using the link below.');
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The dashboard returned an unexpected response. Restart its backend and refresh this page.');
  const body=await response.json();if(!response.ok)throw new Error(body.error||'Card lookup failed.');
  $('card-location').textContent=`Contract ${body.address} · Registry ${body.registry} · Block ${body.blockNumber} · ${body.active?'Active':'Inactive'} · Hash ${body.hash}`;
  $('card-json').textContent=JSON.stringify(body.card,null,2);
 } catch(e) { $('card-location').textContent='On-chain card lookup unavailable';$('card-message').textContent=e.name==='TimeoutError'?'Card lookup timed out. Check that the local chain is running, then click Refresh card.':e.message; }
}
const events = new Map();
const labels = {
 'run-started':['Agent 1 begins','Agent 1 → model'], 'model-start':['Model call started','LLM inference'], 'model-end':['Model call completed','LLM response'],
 'directory-discovered':['Specialist discovered on chain','Agent 1 ↔ registry / AgentCard'], 'unpaid-request':['Delegate specialist task','Agent 1 → Agent 2 · SendMessage'],
 'challenge':['Payment required','Agent 2 → Agent 1 · HTTP 402'], 'payment-challenge':['HTTP 402 challenge received','Agent 2 → Agent 1 · PAYMENT-REQUIRED'],
 'challenge-validated':['Payment terms validated','Agent 1 · trusted card & budget'], 'authorization-created':['Payment authorization signed','Agent 1 · host-held EIP-3009'],
 'paid-retry':['Identical request retried with payment','Agent 1 → Agent 2 · SendMessage'], 'verified':['Authorization verified · task created','Agent 2 ↔ facilitator · verify'],
 'task-acknowledged':['A2A task acknowledged','Agent 2 → Agent 1 · Task ID'], 'executing':['Specialist starts its assessment','Agent 2 · LLM execution'],
 'output-validated':['Specialist output validated','Agent 2 · schema accepted'], 'execution-succeeded':['Result staged privately','Agent 2 · output withheld'],
 'settling':['Payment settlement requested','Agent 2 → facilitator · settle'], 'settlement-pending':['Waiting for chain confirmation','Facilitator ↔ local chain'],
 'settled':['Token transfer independently confirmed','Local chain → Agent 2'], 'delivered':['Delivery gate opened','Agent 2 · Task completed'],
 'task-poll':['Read-only task poll','Agent 1 → Agent 2 · GetTask'], 'task-read':['Task state returned','Agent 2 → Agent 1 · GetTask'],
 'result-received':['Paid specialist result received','Agent 2 → Agent 1 · artifact + receipt'], 'run-completed':['Final recommendation ready','Agent 1 → user'],
 'execution-failed':['Execution failed · no settlement','Agent 2 · authorization unused by framework'], 'settlement-failed':['Settlement failed · output withheld','Agent 2 · result remains private'],
 'unresolved':['Request outcome unresolved','Agent 2 · no automatic recovery'], 'run-failed':['Experiment failed','Workflow stopped'], 'run-unresolved':['Interrupted · unresolved','No automatic retries or payments'],
 'tool-start':['Tool invoked','Agent 1 → host tool'], 'tool-end':['Tool completed','Host tool → Agent 1'],
 'agent-tool-call':['Agent 1 calls a tool','Client agent → host tool'], 'agent-tool-response':['Tool response returned','Host tool → client agent'], 'agent-text':['LLM generated text','Agent response']
};
const money = n => n === undefined ? '—' : (Number(n)/1e6).toFixed(2)+' USD';
const friendly = s => (s||'').replaceAll('-',' ').replace('TASK_STATE_','').replaceAll('_',' ');
function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function currentEvents() { return [...events.values()].filter(e => e.runId === selected || (snapshot?.runs.find(r=>r.id===selected)?.messageId && e.messageId===snapshot.runs.find(r=>r.id===selected).messageId)).sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.sequence-b.sequence); }
function render() {
 if (!snapshot) return;
 const run = snapshot.runs.find(r=>r.id===selected);
 const ready = snapshot.ready && !snapshot.active;
 $('start').disabled = !ready;
 $('start-hint').textContent = snapshot.active ? 'Experiment in progress. Follow the live exchange.' : snapshot.ready ? 'One delegation · maximum payment 2 TestUSD' : 'Waiting for local services and model configuration.';
 $('health').replaceChildren(...[['Local chain',snapshot.local.ready],['Agent server',snapshot.services.server],['Facilitator',snapshot.services.facilitator],['Models configured',snapshot.models.agent1.ready&&snapshot.models.agent2.ready]].map(([label,ok])=>node('span',label,`health-item ${ok?'ready':''}`)));
 $('setup-detail').textContent = JSON.stringify({registry:snapshot.local.registry,card:snapshot.local.card,models:snapshot.models},null,2);
 for (const a of ['agent1','agent2']) $(''+a+'-model').textContent = snapshot.models[a].id || 'Model not configured';
 $('client-balance').textContent = money(snapshot.local.balances?.client); $('card-balance').textContent = money(snapshot.local.balances?.card);
 $('runs').replaceChildren(...(snapshot.runs.length ? snapshot.runs.map(r=>{ const b=node('button',undefined,`run-item ${r.id===selected?'selected':''}`);b.append(node('span',r.task),node('small',`${r.status.toUpperCase()} · ${new Date(r.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`));b.onclick=()=>{selected=r.id;selectedEvent=undefined;render();};return b;}) : [node('p','Your experiments will appear here.','muted')]));
 const list = currentEvents();
 $('event-count').textContent = `${list.length} EVENTS`;
 $('run-title').textContent = run ? (run.status==='completed'?'Experiment complete':run.status==='running'?'An exchange in motion':run.status==='unresolved'?'Outcome unresolved':'Experiment stopped') : selected ? 'Starting the experiment' : 'Ready when you are';
 $('run-status').textContent = (run?.status ?? 'idle').toUpperCase();$('run-status').className=`badge ${run?.status||''}`;
 $('evidence').hidden=!run; if(run) $('evidence').href=`/api/evidence/${run.id}`;
 $('identifiers').replaceChildren(...[['Run ID',run?.id||selected],['Message ID',run?.messageId],['A2A task ID',run?.taskId]].flatMap(([k,v])=>[node('dt',k),node('dd',v||'—')]));
 for (const a of ['agent1','agent2']) {
  const last = list.filter(e=>e.source===a && !['tool-end','task-poll'].includes(e.type)).at(-1);
  $(''+a+'-activity').textContent = last ? (last.type==='tool-start'?`Using ${last.data.tool}`:(labels[last.type]?.[0]||friendly(last.type))) : (a==='agent1'?'Waiting for your task':'Waiting for a delegation');
  $(''+a+'-dot').classList.toggle('active',Boolean(run?.status==='running' && last && last.type!=='model-end' && last.type!=='delivered'));
  const lastUsage = list.filter(e=>e.source===a&&e.type==='model-end').at(-1);
  $(''+a+'-usage').textContent=lastUsage ? `${(lastUsage.data.durationMs/1000).toFixed(1)}s${lastUsage.data.usage?.total_tokens?` · ${lastUsage.data.usage.total_tokens} tok`:''}` : '—';
  const feed = $(a+'-feed');
  const activity = list.filter(e=>e.source===a && !['tool-end','task-poll','task-read'].includes(e.type));
  feed.replaceChildren(...(activity.length ? activity.map(e=>{
   const card=node('article',undefined,`feed-item ${e.type==='agent-text'?'generated-text':''} ${e.type.includes('tool')?'tool-item':''}`);
   const title = e.type==='agent-text' ? 'LLM response' : e.type==='agent-tool-call' ? `Tool call · ${e.data.tool}` : e.type==='agent-tool-response' ? `Tool response · ${e.data.tool}` : e.type==='tool-start' ? `Tool running · ${e.data.tool}` : e.type==='model-start' ? 'LLM inference started' : e.type==='model-end' ? `LLM turn complete · ${e.data.response?.finishReason||'response'}` : e.type==='model-error' ? 'LLM request failed' : labels[e.type]?.[0]||friendly(e.type);
   card.append(node('div',title,'feed-title'),node('time',new Date(e.timestamp).toLocaleTimeString([], {hour12:false}),'feed-time'));
   let payload = e.data.output ?? e.data.input ?? e.data.request;
   if (e.type==='model-end' && !payload) payload={textProduced:e.data.response?.hasText,toolCalls:e.data.response?.toolCalls,usage:e.data.usage};
   if (payload!==undefined) card.append(node(typeof payload==='string'?'p':'pre',typeof payload==='string'?payload:JSON.stringify(payload,null,2),'feed-content'));
   return card;
  }) : [node('p',a==='agent1'?'The coordinator\'s model turns and tool calls will appear here.':'The specialist\'s work and delivered response will appear here.','muted') ]));
 }
 let phaseIndex=-1;
 for(const e of list) { const i=({verified:0,executing:1,'execution-succeeded':1,settling:2,'settlement-pending':2,settled:2,delivered:3})[e.type]; if(i!==undefined)phaseIndex=Math.max(i,phaseIndex); }
 $('phases').querySelectorAll('[data-phase]').forEach((el,i)=>{el.className=i<phaseIndex?'done':i===phaseIndex?'current':'';});
 const lastPhase=list.filter(e=>e.source==='agent2'&&e.data.phase).at(-1)?.data.phase;
 $('payment-phase').textContent=friendly(lastPhase)||'—';
 const taskState=list.filter(e=>e.data.state).at(-1)?.data.state;$('task-state').textContent=friendly(taskState)||'—';
 const tx=run?.transaction || list.filter(e=>e.data.transaction).at(-1)?.data.transaction;$('tx').textContent=tx||'Not submitted';
 $('payment-state').textContent=phaseIndex===3?'Confirmed · specialist result released':phaseIndex===2?'Settlement in progress':phaseIndex===1?'Execution in progress · result private':phaseIndex===0?'Authorization verified':list.some(e=>e.type==='authorization-created')?'Authorization created · not settled':'No authorization created';
 if(['execution-failed','settlement-failed','unresolved'].includes(lastPhase)) $('payment-state').textContent=friendly(lastPhase)+' · result withheld';
 $('gate-note').textContent=phaseIndex===3?'Confirmed transfer checked. The specialist artifact is now available.':phaseIndex>=1?'The specialist result stays private until the token transfer confirms.':'A signed authorization permits execution. Confirmed settlement permits delivery.';
 if (list.length) {
  const visible=[];
  for (const e of list.filter(e=>!['tool-end','task-read'].includes(e.type))) {
   const prev=visible.at(-1);
   if(e.type==='task-poll'&&prev?.event.type==='task-poll'&&prev.event.data.phase===e.data.phase){prev.count++;prev.event=e;prev.items.push(e);}else visible.push({event:e,count:1,items:[e]});
  }
  const nearBottom=$('timeline').scrollHeight-$('timeline').scrollTop-$('timeline').clientHeight<80;
  $('timeline').replaceChildren(...visible.map(({event:e,count,items})=>{
   const row=node('button',undefined,`event-row ${e.source} ${selectedEvent===e.id?'selected':''}`);
   const label=labels[e.type]||[friendly(e.type),e.source];
   row.append(node('span',new Date(e.timestamp).toLocaleTimeString([], {hour12:false}),'event-time'),node('span',e.source==='agent2'?'◆':e.source==='agent1'?'↗':'⌁','event-marker'));
   const main=node('span',e.type==='tool-start'?`Tool · ${e.data.tool}`:label[0],'event-label');main.append(node('small',label[1]));row.append(main);
   if(count>1)row.append(node('span',`×${count}`,'event-tag'));else if(e.data.state)row.append(node('span',friendly(e.data.state),'event-tag'));else if(e.data.status===402)row.append(node('span','402','event-tag'));
   row.onclick=()=>{selectedEvent=e.id;$('inspect-title').textContent=label[0];$('inspect-help').textContent=`${e.source} · sequence ${e.sequence}`;$('inspect-data').textContent=JSON.stringify(count>1?{polls:items}:e,null,2);render();};return row;
  }));
  if(nearBottom&&!selectedEvent)$('timeline').scrollTop=$('timeline').scrollHeight;
 }else{const empty=node('div',undefined,'empty-state');empty.append(node('span','↔','empty-glyph'),node('h3','The conversation starts here'),node('p','Discovery, A2A messages, task polls and settlement appear as the experiment unfolds.'));$('timeline').replaceChildren(empty);}
 if(!selectedEvent){$('inspect-title').textContent='Event inspector';$('inspect-help').textContent='Select an event to see its public payload.';$('inspect-data').textContent='';}
 $('result').hidden=!run?.output;$('outcome-note').hidden=Boolean(run?.output||run?.error);$('failure').hidden=!run?.error;
 if(run?.output){$('final-output').textContent=run.output;$('assessment').textContent=typeof run.assessment==='object'?JSON.stringify(run.assessment,null,2):String(run.assessment||'');}
 if(run?.error)$('failure').textContent=`${run.status.toUpperCase()}: ${run.error}${run.status==='unresolved'?' The server may still be working or payment may have settled. No automatic resubmission or new payment will occur.':''}`;
}
async function refresh() { try { const r=await fetch('/api/snapshot');if(!r.ok)throw new Error();snapshot=await r.json();if(!selected&&snapshot.runs.length)selected=snapshot.runs[0].id;if(!$('task').value)$('task').value=snapshot.sampleTask;render();}catch{$('connection').textContent='Snapshot unavailable';$('connection').className='connection';} }
$('setup-button').onclick=()=>{const expanded=$('setup').hidden;$('setup').hidden=!expanded;$('setup-button').setAttribute('aria-expanded',String(expanded));};
$('card-reload').onclick=()=>{ $('card-message').textContent='';loadCard(); };
loadCard();
$('start').onclick=async()=>{
 $('start').disabled=true;$('action-error').textContent='';
 try{const r=await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json','x-session-token':session},body:JSON.stringify({task:$('task').value})});const body=await r.json();if(!r.ok)throw new Error(body.error);selected=body.id;selectedEvent=undefined;await refresh();}catch(e){$('action-error').textContent=e.message;await refresh();}
};
(async()=>{try{session=(await(await fetch('/api/session')).json()).token;}catch{$('action-error').textContent='Dashboard session unavailable.';}await refresh();const stream=new EventSource('/api/events');stream.onopen=()=>{$('connection').textContent='Live event stream';$('connection').className='connection online';};stream.onerror=()=>{$('connection').textContent='Disconnected · reconnecting';$('connection').className='connection';};stream.onmessage=e=>{const item=JSON.parse(e.data);events.set(item.id,item);if(events.size>2500)events.delete(events.keys().next().value);if(item.runId===selected)render();};stream.addEventListener('gap',()=>{$('action-error').textContent='Some earlier events are outside the retained stream. Restoring a read-only snapshot.';refresh();});setInterval(refresh,2500);})();
