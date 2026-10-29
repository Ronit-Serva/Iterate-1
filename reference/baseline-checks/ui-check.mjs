import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { lineReader, sanitize } from '../apps/dashboard/src/events.js';

// Integration check against an already running npm run ui. It starts/stops only
// dashboard-owned services and requires their ports to be free initially.
const base = 'http://127.0.0.1:4030';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let token;
const received = [];
const started = [];
const report = { passed: false, checkpoints: [], checks: [], runs: [] };
const abort = new AbortController();
async function request(route, body, expected = 200, custom = {}) {
  const response = await fetch(base + route, body === undefined ? { ...custom } : { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-dashboard-token': token, ...custom.headers }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(operation, predicate, description, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const data = await operation(); if (predicate(data)) return data; await delay(180); }
  throw new Error(`Timed out: ${description}`);
}
async function advance(id, stages) {
  for (const stage of stages) {
    const run = await waitFor(() => request(`/api/runs/${id}`), run => run.checkpoint?.stage === stage || run.error, stage);
    assert(!run.error, run.error);
    assert.equal(run.checkpoint.stage, stage);
    if (['verify', 'settle'].includes(stage)) {
      assert(!run.transaction, `${stage} cannot be displayed as a confirmed transfer`);
    }
    if (stage === 'execute') {
      assert.equal(run.evidence.receipt.status, 'success');
      assert(run.evidence.events.some(event => event.event === 'Transfer'));
      assert(run.evidence.events.some(event => event.event === 'AuthorizationUsed'));
      assert.equal(run.evidence.applicationStatus, 'paid');
    }
    await request(`/api/runs/${id}/continue`, { checkpointId: run.checkpoint.checkpointId });
    await request(`/api/runs/${id}/continue`, { checkpointId: run.checkpoint.checkpointId }, 409);
    report.checkpoints.push(stage);
  }
}
let reading;
try {
  const lines = [];
  const reader = lineReader(line => lines.push(line));
  reader.write(Buffer.from('Private Ke')); reader.write(Buffer.from(`y: 0x${'1'.repeat(64)}\nordinary log\n`)); reader.end();
  assert(!lines.join('\n').includes('1'.repeat(64)));
  assert.equal(sanitize({ signature: 'proof', privateKey: 'secret', transaction: '0xabc' }).signature, '[omitted]');
  report.checks.push('chunk-safe secret redaction');

  const initial = await request('/api/status'); token = initial.sessionToken;
  for (const name of ['node', 'facilitator', 'server']) assert(!initial.processes[name].occupied, `Stop existing ${name} before this check; it will not be replaced.`);
  await request('/api/actions/node', {}, 403, { headers: { origin: 'http://untrusted.example' } });
  await request('/api/actions/arbitrary-command', {}, 409);
  await request('/api/runs', { numbers: [2, 4, 6] }, 409);
  await request('/api/runs', { numbers: [] }, 409);
  const page = await fetch(base); assert.equal(page.status, 200); assert((await page.text()).includes('The journey of a paid request'));
  report.checks.push('same-origin mutation protection', 'action allowlist', 'prerequisite and input errors', 'dashboard HTTP response');

  const stream = await fetch(`${base}/api/events`, { signal: abort.signal });
  const streamReader = stream.body.getReader();
  reading = (async () => { const decoder = new TextDecoder(); let buffer = ''; while (true) { const { value, done } = await streamReader.read(); if (done) return; buffer += decoder.decode(value, { stream: true }); let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = block.split('\n').find(line => line.startsWith('data: ')); if (data && !block.startsWith('event: session')) received.push(JSON.parse(data.slice(6))); } } })().catch(error => { if (error.name !== 'AbortError') throw error; });
  await request('/api/actions/node', {}); started.push('node');
  await request('/api/actions/node', {}, 409);
  await waitFor(() => request('/api/status'), state => state.processes.node.ready, 'node readiness');
  await request('/api/actions/compile', {});
  await waitFor(() => request('/api/status'), state => state.processes.compile.state === 'complete' && !state.busy, 'compile completion');
  await request('/api/actions/deploy', {});
  await waitFor(() => request('/api/status'), state => state.deployment.valid && state.processes.deploy.state === 'complete' && !state.busy, 'fixture deployment', 50_000);
  const cli = spawn(process.execPath, ['--import', 'tsx', 'apps/client/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOCAL_WALKTHROUGH: '0', LOCAL_RESUME_ID: '' } });
  let cliOutput = ''; cli.stdout.on('data', chunk => { cliOutput += chunk; }); cli.stderr.on('data', chunk => { cliOutput += chunk; });
  assert.equal(await new Promise(resolve => cli.once('exit', resolve)), 1);
  assert(cliOutput.includes('Server agent unavailable at http://127.0.0.1:4021'));
  assert(!cliOutput.includes('Error.captureStackTrace'));
  report.checks.push('friendly CLI diagnosis for reported port-4021 error');
  await request('/api/actions/facilitator', {}); started.push('facilitator');
  await waitFor(() => request('/api/status'), state => state.processes.facilitator.ready, 'facilitator readiness');
  await request('/api/actions/server', {}); started.push('server');
  await waitFor(() => request('/api/status'), state => state.processes.server.ready, 'server readiness');
  const first = await request('/api/runs', { numbers: [2, 4, 6] });
  await advance(first.id, ['read-card', 'unpaid-request', 'authorize', 'paid-retry', 'verify', 'settle', 'execute']);
  const completed = await waitFor(() => request(`/api/runs/${first.id}`), run => run.status === 'complete', 'result');
  assert.equal(completed.result.signatures, 1); assert.equal(completed.result.challenges, 1);
  assert.equal(completed.result.before.client, '100000000'); assert.equal(completed.result.after.client, '98000000'); assert.equal(completed.result.after.card, '2000000');
  assert.deepEqual(completed.result.result.parts[0].content.value, { count: 3, sum: 12, min: 2, max: 6, mean: 4 });
  const types = completed.events.map(event => event.type);
  assert(types.indexOf('paid') < types.indexOf('execution')); assert(types.indexOf('execution') < types.indexOf('result'));
  report.runs.push({ id: first.id, transaction: completed.transaction, result: completed.result, evidence: completed.evidence });
  report.checks.push('complete real manual paid A2A request', 'confirmed settlement before execution', 'balance and token-event evidence');

  await waitFor(() => request('/api/status'), state => !state.activeRun, 'first client exit');
  const second = await request('/api/runs', { numbers: [1, 3, 5] });
  await advance(second.id, ['read-card', 'unpaid-request', 'authorize', 'paid-retry', 'verify', 'settle']);
  const paid = await waitFor(() => request(`/api/runs/${second.id}`), run => run.checkpoint?.stage === 'execute', 'post-settlement pause');
  assert.equal(paid.evidence.applicationStatus, 'paid');
  await request(`/api/runs/${second.id}/cancel`, {});
  await waitFor(() => request('/api/status'), state => !state.activeRun, 'cancelled client exit');
  await request('/api/runs', { numbers: [2] }, 409);
  await request(`/api/runs/${second.id}/close`, {});
  const closed = await waitFor(() => request(`/api/runs/${second.id}`), run => run.resolved, 'closed recorded outcome');
  assert.equal(closed.status, 'closed — paid');
  assert.equal(closed.transaction, paid.transaction);
  report.runs.push({ id: second.id, transaction: closed.transaction, status: closed.status, evidence: closed.evidence });
  report.checks.push('cancel after confirmed payment', 'unresolved attempt blocks new payment', 'record paid-but-undelivered outcome without saving or replaying authorization');
  await waitFor(() => request('/api/status'), state => !state.activeRun, 'cancelled client exit');
  const secrets = ['client', 'facilitator'].map(role => JSON.parse(fs.readFileSync(`runtime/${role}-key.json`, 'utf8')).privateKey);
  const publicOutput = JSON.stringify({ received, completed, closed });
  for (const secret of secrets) assert(!publicOutput.includes(secret), 'Secret found in public dashboard output');
  assert(received.some(event => event.source === 'node' && event.type === 'log'));
  assert(received.some(event => event.type === 'submitted'));
  report.checks.push('actual SSE logs and protocol events', 'no signer keys in public output');

  // A real pause timeout must not sign, charge, or execute anything.
  const timed = await request('/api/runs', { numbers: [9] });
  await waitFor(() => request(`/api/runs/${timed.id}`), run => run.checkpoint?.stage === 'read-card', 'timeout checkpoint');
  const expired = await waitFor(() => request(`/api/runs/${timed.id}`), run => run.error, '60-second checkpoint expiry', 70_000);
  assert(!expired.submitted); assert(!expired.result);
  report.checks.push('bounded 60-second checkpoint expiry without signing or charging');
  await waitFor(() => request('/api/status'), state => !state.activeRun, 'expired client exit');

  for (const name of ['server', 'facilitator', 'node']) {
    await request(`/api/processes/${name}/stop`, {});
    await waitFor(() => request('/api/status'), state => !state.processes[name].occupied, `${name} stop before reset`);
  }
  await request('/api/actions/node', {});
  const reset = await waitFor(() => request('/api/status'), state => state.processes.node.ready && !state.deployment.valid, 'stale deployment rejection');
  assert(reset.deployment.error);
  await request('/api/runs', { numbers: [2] }, 409);
  report.checks.push('actual chain restart invalidates deployment and blocks paid runs');
  report.passed = true;
} finally {
  abort.abort(); if (reading) await reading;
  for (const name of started.reverse()) {
    try {
      const state = await request('/api/status');
      if (state.processes[name].ownership === 'dashboard') await request(`/api/processes/${name}/stop`, {});
      await waitFor(() => request('/api/status'), state => !state.processes[name].occupied, `${name} shutdown`);
    } catch (error) { report.passed = false; console.error(`Cleanup: ${name}: ${error.message}`); }
  }
  fs.writeFileSync('evidence/UI-result.json', JSON.stringify(report, null, 2) + '\n');
}
assert(report.passed, 'Dashboard verification or cleanup did not pass');
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, evidence: 'evidence/UI-result.json' }, null, 2));
