import '../packages/shared/src/env.js';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
const children: ChildProcess[] = [];
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children.reverse()) child.kill('SIGTERM'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
function launch(args: string[], quiet = false) {
  const child = spawn(process.execPath, args, { stdio: quiet ? 'ignore' : 'inherit', env: process.env }); children.push(child);
  child.once('exit', code => { if (!stopping) { console.error(`Service exited (${code}); stopping owned services`); process.exitCode = 1; stop(); } });
  return child;
}
async function free(port: number) {
  await new Promise<void>((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(new Error(`Port ${port} is in use; stop that service before starting this fresh fixture`))); s.listen(port, '127.0.0.1', () => s.close(() => resolve())); });
}
async function once(args: string[]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Setup exited ${code}`))); });
}
async function ready(url: string, rpc = false) {
  for (let i = 0; i < 100 && !stopping; i++) {
    try { const r = await fetch(url, rpc ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) } : { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
try {
  if (process.env.RPC_URL && process.env.RPC_URL !== 'http://127.0.0.1:8545') throw new Error('npm start owns the default local RPC; use individual service commands for another port');
  await Promise.all([8545, 4021, 4022, Number(process.env.DASHBOARD_PORT ?? 4030)].map(free));
  await once(['scripts/compile.mjs']);
  launch(['node_modules/hardhat/dist/src/cli.js', 'node', '--hostname', '127.0.0.1'], true);
  await ready('http://127.0.0.1:8545', true);
  await once(['--import', 'tsx', 'scripts/fixture.mjs']);
  launch(['--import', 'tsx', 'scripts/facilitator.mjs']); await ready('http://127.0.0.1:4022/health');
  launch(['--import', 'tsx', 'apps/server/src/index.ts']); await ready('http://127.0.0.1:4021/health');
  launch(['--import', 'tsx', 'apps/dashboard/src/index.ts']); await ready(`http://127.0.0.1:${process.env.DASHBOARD_PORT ?? 4030}/api/session`);
  console.log('Ready. Open http://127.0.0.1:4030. Ctrl+C stops only this command’s services.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; stop(); }
