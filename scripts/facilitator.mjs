import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { createPublicClient, createWalletClient, defineChain, http, parseAbiItem, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, assertDeployment } from '../packages/shared/src/local.js';
import { event } from '../packages/experiment/src/events.js';
function emit(source, type, messageId, data) {
  event(source, type, messageId ?? 'unbound', { transaction: data.transaction, receipt: data, status: data.isValid ?? data.success }, { messageId });
}

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const manifest = JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
if (rpcUrl !== manifest.rpcUrl) throw new Error('Facilitator RPC must match the local deployment manifest');
const chainId = Number(manifest.chainId);
const chain = defineChain({ id: chainId, name: 'Hardhat Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const gasAccount = privateKeyToAccount(JSON.parse(fs.readFileSync('runtime/facilitator-key.json', 'utf8')).privateKey);
if (gasAccount.address.toLowerCase() !== manifest.facilitator.toLowerCase()) throw new Error('Facilitator key does not match deployment');
const walletClient = createWalletClient({ account: gasAccount, chain, transport: http(rpcUrl) });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb', strict: true }));

const token = manifest.token.toLowerCase();
const payTo = manifest.agentCard.toLowerCase();
const recordsPath = path.resolve(`runtime/${manifest.anchor.blockHash}/facilitator-settlements.json`);
const inFlight = new Map();
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function readRecords() {
  try { return JSON.parse(fs.readFileSync(recordsPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function writeRecords(records) {
  fs.mkdirSync(path.dirname(recordsPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${recordsPath}.${process.pid}.tmp`;
  const fd = fs.openSync(temporaryPath, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(records, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporaryPath, recordsPath);
}
const records = readRecords();
let migrated = false;
for (const record of Object.values(records)) {
  if (record.authorization) {
    record.payer ??= record.authorization.from;
    record.nonce ??= record.authorization.nonce;
    delete record.authorization;
    migrated = true;
  }
}
if (migrated) writeRecords(records);
const settling = new AsyncLocalStorage();
const baseSigner = toFacilitatorEvmSigner({ ...publicClient, ...walletClient, address: manifest.facilitator }, { confirmationTimeoutMs: Number(process.env.LOCAL_CONFIRMATION_TIMEOUT_MS ?? 10_000) });
const signer = { ...baseSigner, async writeContract(args) {
  const context = settling.getStore();
  if (!context) throw new Error('Settlement context required');
  const hash = await baseSigner.writeContract(args);
  if (process.env.LOCAL_FAULTS === '1' && context.fault === 'crash-before-hash-persistence') process.exit(73);
  records[context.key].transaction = hash;
  records[context.key].status = 'pending';
  writeRecords(records);
  emit('facilitator', 'submitted', context.runId, { transaction: hash });
  return hash;
} };
const x402 = new x402Facilitator().register(`eip155:${chainId}`, new ExactEvmScheme(signer));

async function reconcile(record) {
  const payer = record.payer;
  const nonce = record.nonce;
  if (!record.transaction) {
    const logs = await publicClient.getLogs({ address: manifest.token, event: parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'), args: { authorizer: payer, nonce }, fromBlock: BigInt(manifest.anchor.blockNumber), toBlock: 'latest' });
    const hashes = [...new Set(logs.map(log => log.transactionHash))];
    if (hashes.length === 1) record.transaction = hashes[0];
  }
  const result = { success: false, errorReason: record.transaction ? 'settlement_pending' : 'settlement_unknown', transaction: record.transaction ?? '', network: `eip155:${chainId}`, payer };
  if (record.transaction) {
    let receipt;
    try { receipt = await publicClient.getTransactionReceipt({ hash: record.transaction }); }
    catch { record.status = 'pending'; record.response = result; writeRecords(records); return result; }
    if (receipt.status === 'reverted') { result.errorReason = 'transaction_reverted'; record.status = 'failed'; }
    else {
      const events = receipt.logs.filter(log => log.address.toLowerCase() === token).flatMap(log => {
        try { return [decodeEventLog({ abi: artifact('TestUSD').abi, data: log.data, topics: log.topics })]; } catch { return []; }
      });
      const used = events.some(event => event.eventName === 'AuthorizationUsed' && event.args.authorizer.toLowerCase() === payer.toLowerCase() && event.args.nonce.toLowerCase() === nonce.toLowerCase());
      const transferred = events.some(event => event.eventName === 'Transfer' && event.args.from.toLowerCase() === payer.toLowerCase() && event.args.to.toLowerCase() === payTo && event.args.value === 2_000_000n);
      if (used && transferred) { result.success = true; delete result.errorReason; record.status = 'confirmed'; }
      else { result.errorReason = 'settlement_unknown'; record.status = 'unknown'; }
    }
  } else { record.status = 'unknown'; }
  record.response = result;
  writeRecords(records);
  return result;
}
function checkProfile(requirements) {
  return requirements && requirements.scheme === 'exact' && requirements.network === `eip155:${chainId}`
    && typeof requirements.asset === 'string' && requirements.asset.toLowerCase() === token
    && typeof requirements.payTo === 'string' && requirements.payTo.toLowerCase() === payTo
    && requirements.amount === '2000000' && requirements.maxTimeoutSeconds > 0
    && requirements.maxTimeoutSeconds <= 600 && requirements.extra?.name === 'TestUSD'
    && requirements.extra?.version === '1';
}
function parseRequest(body) {
  const paymentPayload = body?.paymentPayload;
  const paymentRequirements = body?.paymentRequirements;
  if (body?.x402Version !== 2 || paymentPayload?.x402Version !== 2 || !checkProfile(paymentRequirements)
      || !checkProfile(paymentPayload.accepted)) throw new Error('payment profile does not match the configured local terms');
  if (canonical(paymentPayload.accepted) !== canonical(paymentRequirements)) throw new Error('accepted terms differ from requested requirements');
  const authorization = paymentPayload.payload?.authorization;
  if (!authorization || typeof authorization.from !== 'string' || typeof authorization.nonce !== 'string'
      || authorization.to?.toLowerCase() !== payTo || authorization.value !== '2000000') {
    throw new Error('payload is not the configured EIP-3009 authorization');
  }
  return { paymentPayload, paymentRequirements, authorization };
}
function authorizationKey(authorization) {
  return `${chainId}:${token}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
}
function lock(key, operation) {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  let tracked;
  tracked = current.finally(() => { if (inFlight.get(key) === tracked) inFlight.delete(key); });
  inFlight.set(key, tracked);
  return tracked;
}

app.get('/health', async (_req, res) => {
  try {
    await assertDeployment(manifest);
    const actualChainId = await publicClient.getChainId();
    res.json({ ok: actualChainId === chainId, chainId: actualChainId, anchor: manifest.anchor, address: manifest.facilitator });
  } catch (error) { res.status(503).json({ ok: false, error: error.message }); }
});
app.get('/supported', (_req, res) => res.json(x402.getSupported()));
app.post('/verify', async (req, res) => {
  try {
    await assertDeployment(manifest);
    const { paymentPayload, paymentRequirements } = parseRequest(req.body);
    const result = await x402.verify(paymentPayload, paymentRequirements);
    emit('facilitator', 'verification-result', req.header('x-local-request-id'), result);
    res.json(result);
  } catch (error) {
    res.status(400).json({ isValid: false, invalidReason: error.message });
  }
});
app.post('/settle', async (req, res) => {
  let parsed;
  try { parsed = parseRequest(req.body); }
  catch (error) { return res.status(400).json({ success: false, errorReason: error.message }); }
  const { paymentPayload, paymentRequirements, authorization } = parsed;
  const key = authorizationKey(authorization);
  const fingerprint = crypto.createHash('sha256').update(canonical({ paymentPayload, paymentRequirements })).digest('hex');
  try {
    await assertDeployment(manifest);
    const response = await lock(key, async () => {
      const previous = records[key];
      if (previous && previous.fingerprint !== fingerprint) {
        const conflict = new Error('authorization key was already used with different payment terms or payload');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (previous?.status === 'failed') return previous.response;
      if (previous) return reconcile(previous);

      const verification = await x402.verify(paymentPayload, paymentRequirements);
      if (!verification.isValid) {
        return { success: false, errorReason: verification.invalidReason ?? 'payment verification failed', payer: authorization.from, network: paymentRequirements.network };
      }

      // Retain only the public payer/nonce needed for idempotency and event-based
      // recovery. The signed authorization and signature are never persisted.
      records[key] = { fingerprint, payer: authorization.from, nonce: authorization.nonce, status: 'broadcasting', updatedAt: new Date().toISOString() };
      writeRecords(records);
      let result;
      try {
        result = await settling.run({ key, runId: req.header('x-local-request-id'), fault: req.header('x-local-fault') }, () => x402.settle(paymentPayload, paymentRequirements));
      } catch { return reconcile(records[key]); }
      if (records[key].transaction || result.transaction) {
        records[key].transaction ??= result.transaction;
        return reconcile(records[key]);
      }
      records[key].status = result.success ? 'unknown' : 'failed';
      records[key].response = result;
      writeRecords(records);
      return result;
    });
    emit('facilitator', response.success ? 'confirmed' : 'settlement-unresolved', req.header('x-local-request-id'), response);
    if (process.env.LOCAL_FAULTS === '1' && req.header('x-local-fault') === 'drop-settle-response') return res.destroy();
    if (!response?.success && response?.errorReason === undefined && response?.error === undefined) return res.status(409).json(response);
    return res.json(response);
  } catch (error) {
    return res.status(error.statusCode ?? 500).json({ success: false, errorReason: error.message });
  }
});
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));

const port = Number(process.env.FACILITATOR_PORT ?? 4022);
await assertDeployment(manifest);
const [actualChainId, tokenCode, cardCode] = await Promise.all([
  publicClient.getChainId(), publicClient.getCode({ address: manifest.token }), publicClient.getCode({ address: manifest.agentCard }),
]);
if (actualChainId !== chainId || !tokenCode || tokenCode === '0x' || !cardCode || cardCode === '0x') {
  throw new Error('deployment manifest is stale or does not match the connected local chain');
}
app.listen(port, '127.0.0.1', () => console.log(`Facilitator listening on http://127.0.0.1:${port}`));
