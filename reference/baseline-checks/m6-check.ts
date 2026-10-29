import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Message } from '@a2a-js/sdk';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseAbiItem } from 'viem';
import { encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { artifact, assertDeployment, deployment } from '../packages/shared/src/local.js';
import { EXTENSION, requirements } from '../packages/shared/src/card.js';
import { statePath } from '../packages/shared/src/store.js';

const config = deployment();
const chain = await assertDeployment(config);
const token = { address: config.token, abi: artifact('TestUSD').abi };
const account = privateKeyToAccount(JSON.parse(fs.readFileSync('runtime/client-key.json', 'utf8')).privateKey);
const terms = requirements(config);
const headers = { 'content-type': 'application/json', 'a2a-version': '1.0', 'a2a-extensions': EXTENSION };
const children = new Set<ChildProcess>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function start(entry: string, port: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, LOCAL_FAULTS: '1', LOCAL_CONFIRMATION_TIMEOUT_MS: '600' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let logs = '';
  child.stdout?.on('data', data => { logs = (logs + data.toString()).slice(-6000); });
  child.stderr?.on('data', data => { logs = (logs + data.toString()).slice(-6000); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Process exited: ${logs}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return child; } catch {}
    await delay(100);
  }
  throw new Error(`Process did not start: ${logs}`);
}
async function stopped(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
}
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await stopped(child); children.delete(child); }
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
async function makeRequest() {
  const signed = await new ExactEvmScheme(toClientEvmSigner(account)).createPaymentPayload(2, terms);
  const payload: PaymentPayload = { x402Version: 2, accepted: terms, payload: signed.payload };
  const id = crypto.randomUUID();
  const body = { jsonrpc: '2.0', id, method: 'SendMessage', params: { message: Message.toJSON(Message.fromJSON({ messageId: id, role: 'ROLE_USER', parts: [{ data: { numbers: [2, 4, 6] }, mediaType: 'application/json' }] })) } };
  return { id, payload, body };
}
type PaidRequest = Awaited<ReturnType<typeof makeRequest>>;
async function post(request: PaidRequest, fault?: string, paid = true) {
  const response = await fetch('http://127.0.0.1:4021', { method: 'POST', headers: { ...headers, ...(paid ? { 'payment-signature': encodePaymentSignatureHeader(request.payload) } : {}), ...(fault ? { 'x-local-fault': fault } : {}) }, body: JSON.stringify(request.body) });
  const body = await response.json();
  return { status: response.status, body, receipt: response.headers.get('payment-response') ? decodePaymentResponseHeader(response.headers.get('payment-response')!) : undefined };
}
const executions = async () => (await (await fetch('http://127.0.0.1:4021/health')).json() as { executions: number }).executions;
const balance = async () => await chain.readContract({ ...token, functionName: 'balanceOf', args: [config.client] }) as bigint;
const savedRecord = (id: string) => JSON.parse(fs.readFileSync(statePath(config, 'requests'), 'utf8')).requests[id];
const evidence: Record<string, unknown>[] = [];
let facilitator: ChildProcess | undefined;
let server: ChildProcess | undefined;
const originalGas = await chain.getBalance({ address: config.facilitator });
const firstBlock = await chain.getBlockNumber({ cacheTime: 0 });
try {
  facilitator = await start('scripts/facilitator.mjs', 4022);
  server = await start('apps/server/src/index.ts', 4021);

  let request = await makeRequest();
  let before = await balance(); let count = await executions();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => post(request)));
  for (const result of duplicates) { assert.equal(result.status, 200); assert.equal(result.receipt?.success, true); assert.deepEqual(result.body, duplicates[0].body); }
  assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count + 1);
  const changed = structuredClone(request);
  (changed.body.params.message as { parts: { data: { numbers: number[] } }[] }).parts[0].data.numbers = [3, 4, 6];
  assert.equal((await post(changed)).status, 409);
  const stranger = privateKeyToAccount(generatePrivateKey());
  const otherPayment = await new ExactEvmScheme(toClientEvmSigner(stranger)).createPaymentPayload(2, terms);
  assert.equal((await post({ ...request, payload: { x402Version: 2, accepted: terms, payload: otherPayment.payload } })).status, 409);
  const reused = structuredClone(request);
  (reused.body.params.message as { messageId: string }).messageId = crypto.randomUUID();
  assert.equal((await post(reused)).status, 409);
  const anonymous = await post(request, undefined, false);
  assert.equal(anonymous.status, 402); assert.equal(anonymous.body.result, undefined);
  assert.equal(await balance(), before - 2_000_000n);
  evidence.push({ case: 'concurrent/repeated and identity conflicts', transaction: duplicates[0].receipt?.transaction, calls: 4, charges: 1, executions: (await executions()) - count });

  request = await makeRequest(); before = await balance(); count = await executions();
  assert.equal((await post(request, 'drop-facilitator-response')).status, 503);
  assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count);
  const recovered = await post(request);
  assert.equal(recovered.status, 200); assert.equal(await executions(), count + 1); assert.equal(await balance(), before - 2_000_000n);
  evidence.push({ case: 'lost settlement response', transaction: recovered.receipt?.transaction, charges: 1, executions: 1 });

  request = await makeRequest(); before = await balance(); count = await executions();
  await rpc('evm_setAutomine', [false]);
  const pending = await post(request);
  assert.equal(pending.status, 202); assert.equal(pending.body.error, 'pending'); assert(pending.body.receipt.transaction);
  assert.equal(await executions(), count); assert.equal(await balance(), before);
  await rpc('evm_mine'); await rpc('evm_setAutomine', [true]);
  const mined = await post(request);
  assert.equal(mined.status, 200); assert.equal(mined.receipt?.transaction, pending.body.receipt.transaction);
  assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count + 1);
  evidence.push({ case: 'pending then mined', initialStatus: pending.body.error, transaction: mined.receipt?.transaction, executionsWhilePending: 0, charges: 1 });

  request = await makeRequest(); before = await balance(); count = await executions();
  await assert.rejects(post(request, 'crash-after-settlement'));
  await stopped(server); children.delete(server);
  assert.equal(await balance(), before - 2_000_000n);
  assert.equal(savedRecord(request.id).status, 'paid');
  server = await start('apps/server/src/index.ts', 4021);
  const restarted = await post(request);
  assert.equal(restarted.status, 200); assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count + 1);
  evidence.push({ case: 'server restart after settlement', transaction: restarted.receipt?.transaction, charges: 1, executions: 1 });

  request = await makeRequest(); before = await balance(); count = await executions();
  const gasBefore = await chain.getBalance({ address: config.facilitator });
  await rpc('hardhat_setBalance', [config.facilitator, '0x0']);
  let noGas;
  try { noGas = await post(request); } finally { await rpc('hardhat_setBalance', [config.facilitator, `0x${gasBefore.toString(16)}`]); }
  assert.equal(noGas.status, 402); assert.equal(await balance(), before); assert.equal(await executions(), count);
  evidence.push({ case: 'definitive failure without gas', status: noGas.body.error, charges: 0, executions: 0 });

  request = await makeRequest(); before = await balance(); count = await executions();
  const failedService = await post(request, 'service-exception');
  assert.equal(failedService.receipt?.success, true); assert.equal(await balance(), before - 2_000_000n);
  assert.equal(savedRecord(request.id).status, 'paid-undelivered');
  assert.equal((await post(request)).status, 409); assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count + 1);
  evidence.push({ case: 'service exception after payment', transaction: failedService.receipt?.transaction, status: savedRecord(request.id).status, charges: 1, automaticRefund: false });

  request = await makeRequest(); before = await balance(); count = await executions();
  assert.equal((await post(request, 'crash-before-hash-persistence')).status, 503);
  await stopped(facilitator); children.delete(facilitator);
  assert.equal(await balance(), before - 2_000_000n);
  facilitator = await start('scripts/facilitator.mjs', 4022);
  const logRecovery = await post(request);
  assert.equal(logRecovery.status, 200); assert.equal(await balance(), before - 2_000_000n); assert.equal(await executions(), count + 1);
  evidence.push({ case: 'facilitator crash before hash persistence', transaction: logRecovery.receipt?.transaction, reconciledFrom: 'AuthorizationUsed and Transfer logs', charges: 1 });

  request = await makeRequest(); before = await balance(); count = await executions();
  await assert.rejects(post(request, 'drop-result-response'));
  assert.equal(savedRecord(request.id).status, 'completed');
  await stop(server); server = await start('apps/server/src/index.ts', 4021);
  const cached = await post(request);
  assert.equal(cached.status, 200); assert.equal(await executions(), count + 1); assert.equal(await balance(), before - 2_000_000n);
  evidence.push({ case: 'completed result after response loss and restart', transaction: cached.receipt?.transaction, charges: 1, executions: 1 });

  const transfers = await chain.getLogs({ address: config.token, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), args: { from: config.client, to: config.agentCard }, fromBlock: firstBlock + 1n, toBlock: 'latest' });
  assert.equal(transfers.length, 7);
  evidence.push({ case: 'observed payment events', transferCount: transfers.length, transactions: transfers.map(log => log.transactionHash) });
  fs.writeFileSync('evidence/M6-result.json', JSON.stringify({ faultMatrixPassed: true, resetCheckPending: true, deploymentAnchor: config.anchor, evidence }, null, 2) + '\n');
  console.log(JSON.stringify({ faultMatrixPassed: true, resetCheckPending: true, cases: evidence.length, paymentTransfers: transfers.length }, null, 2));
} finally {
  try { await rpc('evm_setAutomine', [true]); } catch {}
  for (const child of children) await stop(child);
}
