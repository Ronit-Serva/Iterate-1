import '../../../packages/shared/src/env.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express, { type Response } from 'express';
import { artifact, assertDeployment, deployment } from '../../../packages/shared/src/local.js';
import { digest } from '../../../packages/shared/src/store.js';
import { modelConfig } from '../../../packages/llm/src/provider.js';
import { event, publicData, runStore, type ExperimentEvent } from '../../../packages/experiment/src/events.js';
import { SAMPLE_TASK } from '../../client/src/agent1.js';
const app = express(); const port = Number(process.env.DASHBOARD_PORT ?? 4030);
const origin = `http://127.0.0.1:${port}`; const token = crypto.randomBytes(24).toString('hex');
app.disable('x-powered-by'); app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return res.status(403).json({ error: 'Local dashboard only' });
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  if (req.method !== 'GET' && (req.header('origin') !== `http://${req.headers.host}` || req.header('x-session-token') !== token)) return res.status(403).json({ error: 'Invalid dashboard session' });
  next();
});
const clients = new Set<Response>();
const known = new Set<string>(); let history: ExperimentEvent[] = []; let active: string | undefined;
// An orphaned client run is unresolved, never automatically restarted.
const startup = runStore();
for (const r of Object.values(startup.state)) if (r.status === 'running') { r.status = 'unresolved'; r.error = 'Dashboard restarted; request outcome unresolved'; }
startup.save();
function ingest(e: ExperimentEvent) {
  if (known.has(e.id)) return; known.add(e.id); history.push(e);
  if (history.length > 2500) { const removed = history.shift()!; known.delete(removed.id); }
  for (const res of clients) {
    if (res.writableLength > 512000) { res.end(); clients.delete(res); continue; }
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  }
}
const offsets = new Map<string, number>();
function scan() {
  if (!fs.existsSync('runtime/events')) return;
  for (const file of fs.readdirSync('runtime/events').filter(f => f.endsWith('.jsonl'))) {
    // Journals are bounded per run by the host's model/poll limits. Read only the
    // last 2 MB per process so reconnect work stays bounded across many runs.
    const p = `runtime/events/${file}`; const size = fs.statSync(p).size;
    const previous = offsets.get(p); const offset = previous !== undefined && previous <= size ? previous : Math.max(0, size-2_000_000);
    if (offset === size) continue;
    const fd = fs.openSync(p, 'r'); const buffer = Buffer.alloc(Math.min(size-offset, 2_000_000));
    try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
    const end = buffer.lastIndexOf(10); if (end < 0) continue;
    offsets.set(p, offset+end+1);
    const lines = buffer.subarray(0, end).toString().split('\n'); if (previous === undefined && offset) lines.shift();
    for (const line of lines) { try { ingest(JSON.parse(line)); } catch { /* Partial final write is read next tick. */ } }
  }
}
scan();
const timer = setInterval(scan, 600); timer.unref();
async function health(url: string, anchor?: string) { try { const res = await fetch(url, { signal: AbortSignal.timeout(1500) }); const body = await res.json(); return res.ok && body.ok === true && (!anchor || body.anchor?.blockHash === anchor); } catch { return false; } }
async function snapshot() {
  let local: any = { ready: false }; let anchor: string | undefined;
  try {
    const d = deployment(); const chain = await assertDeployment(d); anchor = d.anchor.blockHash;
    const token = { address: d.token, abi: artifact('TestUSD').abi };
    const [a, b] = await Promise.all([chain.readContract({ ...token, functionName: 'balanceOf', args: [d.client] }), chain.readContract({ ...token, functionName: 'balanceOf', args: [d.agentCard] })]);
    local = { ready: true, registry: d.registry, card: d.agentCard, network: 'eip155:31337', balances: { client: String(a), card: String(b) } };
  } catch { /* Setup panel explains missing fixture or stale chain. */ }
  const [server, facilitator] = await Promise.all([health('http://127.0.0.1:4021/health', anchor), health('http://127.0.0.1:4022/health', anchor)]);
  const a = modelConfig('agent1'), b = modelConfig('agent2');
  const runs = Object.values(runStore().state).slice(-40).reverse();
  return { local, services: { server: Boolean(local.ready && server), facilitator: Boolean(local.ready && facilitator) }, models: { agent1: { id: a.id, ready: a.ready }, agent2: { id: b.id, ready: b.ready } }, active, ready: Boolean(local.ready && server && facilitator && a.ready && b.ready), runs, sampleTask: SAMPLE_TASK };
}
app.get('/api/session', (_req, res) => res.json({ token }));
app.get('/api/snapshot', async (_req, res) => { try { res.json(await snapshot()); } catch { res.status(503).json({ error: 'Snapshot unavailable' }); } });
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.flushHeaders();
  const last = req.header('last-event-id'); const index = last ? history.findIndex(e => e.id === last) : -1;
  if (last && index < 0) res.write('event: gap\ndata: {}\n\n');
  for (const e of history.slice(index+1)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  clients.add(res); const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
});
app.get('/api/evidence/:id', (req, res) => {
  const run = runStore().state[req.params.id]; if (!run) return res.status(404).json({ error: 'Run not found' });
  const events = history.filter(e => e.runId === run.id || e.messageId === run.messageId);
  res.set('Content-Disposition', `attachment; filename="experiment-${run.id}.json"`).json(publicData({ schemaVersion: 1, ...run, events }));
});
app.post('/api/runs', async (req, res) => {
  if (active) return res.status(409).json({ error: 'An experiment is already running' });
  const task = req.body?.task;
  if (typeof task !== 'string' || task.trim().length < 10 || task.length > 12000) return res.status(400).json({ error: 'Task must contain 10–12000 characters' });
  // Reserve the slot before asynchronous readiness checks to avoid double starts.
  const id = crypto.randomUUID(); active = id;
  try {
    if (!(await snapshot()).ready) { active = undefined; return res.status(409).json({ error: 'Configure both models and start the local services first' }); }
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/client/src/index.ts', task], { cwd: process.cwd(), env: { ...process.env, EXPERIMENT_RUN_ID: id }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', (message: any) => { if (message?.kind === 'experiment-event') ingest(message.event); });
    const finished = () => {
      if (active === id) active = undefined;
      const store = runStore(); const r = store.state[id];
      if (r?.status === 'running') { r.status = 'unresolved'; r.error = 'Agent process interrupted; no automatic resumption'; store.save(); event('dashboard', 'run-unresolved', id, { message: r.error }); }
    };
    child.once('exit', finished); child.once('error', finished);
    res.status(202).json({ id });
  } catch { active = undefined; res.status(503).json({ error: 'Experiment could not start' }); }
});
app.use(express.static('apps/dashboard/public'));
app.listen(port, '127.0.0.1', () => console.log(`Experiment dashboard: ${origin}`));
