import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const processes = new Set();
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(name, args = ['run', name]) {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (code !== 0) throw new Error(`${name} failed (${code}):\n${output}`);
  checks.push({ command: `npm ${args.join(' ')}`, exitCode: code });
  console.log(`PASS ${name}`);
  return output;
}
async function start(entry, port, node = false) {
  const args = node ? ['node_modules/hardhat/dist/src/cli.js', 'node', '--hostname', '127.0.0.1'] : ['--import', 'tsx', entry];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  // Consume node output without saving Hardhat's development private keys.
  let errors = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { if (!node) errors = (errors + String(data)).slice(-4000); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Could not start ${node ? 'Hardhat' : entry}: ${errors}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${node ? '' : 'health'}`, node ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) } : undefined);
      if (response.ok && child.exitCode === null) { await delay(100); if (child.exitCode === null) return child; }
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out starting ${node ? 'Hardhat' : entry}`);
}
async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  processes.delete(child);
}
let node;
try {
  await run('dependency-pins', ['ls', '--depth=0']);
  await run('compile'); await run('typecheck');
  node = await start('', 8545, true);
  await run('m1:local');
  let facilitator = await start('scripts/facilitator.mjs', 4022);
  await run('m2:check'); await stop(facilitator);
  await run('m3:check'); await run('m4:check');
  facilitator = await start('scripts/facilitator.mjs', 4022);
  let server = await start('apps/server/src/index.ts', 4021);
  await run('m5:check'); await stop(server); await stop(facilitator);
  await run('m6:check');
  await stop(node); node = await start('', 8545, true);
  await run('m6:reset-check');
  await run('m1:local'); await run('m7:reuse-check');
  facilitator = await start('scripts/facilitator.mjs', 4022);
  server = await start('apps/server/src/index.ts', 4021);
  const output = await run('client');
  const demo = JSON.parse(output.slice(output.indexOf('{')));
  assert.deepEqual(demo.before, { client: '100000000', card: '0' });
  assert.deepEqual(demo.after, { client: '98000000', card: '2000000' });
  assert.equal(demo.receipt.success, true);
  fs.writeFileSync('evidence/demo.json', JSON.stringify(demo, null, 2) + '\n');
  fs.writeFileSync('evidence/M7-result.json', JSON.stringify({ passed: true, node: process.version, checks, demo, processIsolation: ['Hardhat node', 'facilitator', 'A2A server', 'client'], teardown: 'All processes started by this script are stopped in finally.' }, null, 2) + '\n');
  await run('check:artifacts');
  console.log(`M0–M7 reproduced. Demo transaction: ${demo.receipt.transaction}`);
} finally { for (const child of [...processes].reverse()) await stop(child); }
