import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';

const manifest = JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
const localKey = JSON.parse(fs.readFileSync('runtime/client-key.json', 'utf8')).privateKey;
const rpcUrl = manifest.rpcUrl;
const chain = defineChain({ id: manifest.chainId, name: 'Hardhat Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const ownerWallet = createWalletClient({ account: manifest.owner, chain, transport: http(rpcUrl) });
const account = privateKeyToAccount(localKey);
assert.equal(account.address.toLowerCase(), manifest.client.toLowerCase());
const tokenArtifact = JSON.parse(fs.readFileSync('artifacts/contracts/TestUSD.sol/TestUSD.json', 'utf8'));
const token = { address: manifest.token, abi: tokenArtifact.abi };
const facilitatorUrl = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:4022';
const initialClient = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [account.address] });
const initialCard = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] });
assert.equal(initialClient, 100_000_000n, 'M1 fixture client balance must be 100 TestUSD');
assert.equal(initialCard, 0n, 'M1 fixture card balance must be zero');

const requirements = {
  scheme: 'exact', network: `eip155:${manifest.chainId}`, asset: manifest.token,
  amount: '2000000', payTo: manifest.agentCard, maxTimeoutSeconds: 300,
  extra: { name: 'TestUSD', version: '1' },
};
const paymentScheme = new ExactEvmScheme(toClientEvmSigner(account, publicClient));
const payloadResult = await paymentScheme.createPaymentPayload(2, requirements);
const paymentPayload = { x402Version: 2, accepted: requirements, payload: payloadResult.payload };
const firstBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
const requestBody = { x402Version: 2, paymentPayload, paymentRequirements: requirements };
async function post(path, body) {
  return fetch(`${facilitatorUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const supportedResponse = await fetch(`${facilitatorUrl}/supported`);
assert.equal(supportedResponse.status, 200);
const supported = await supportedResponse.json();
assert(supported.kinds.some((kind) => kind.x402Version === 2 && kind.scheme === 'exact' && kind.network === `eip155:${manifest.chainId}`));
const verifyResponse = await post('/verify', requestBody);
assert.equal(verifyResponse.status, 200);
const verified = await verifyResponse.json();
assert.equal(verified.isValid, true, JSON.stringify(verified));
assert.equal(await publicClient.getBlockNumber({ cacheTime: 0 }), firstBlock);
assert.equal(await publicClient.readContract({ ...token, functionName: 'authorizationState', args: [account.address, paymentPayload.payload.authorization.nonce] }), false);
assert.equal(await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [account.address] }), initialClient);
assert.equal(await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] }), initialCard);

for (const [field, wrongValue] of [
  ['payTo', '0x0000000000000000000000000000000000000001'],
  ['amount', '2000001'], ['asset', '0x0000000000000000000000000000000000000001'], ['network', 'eip155:1'],
]) {
  const wrongRequirements = { ...requirements, [field]: wrongValue };
  const wrongBody = { x402Version: 2, paymentPayload: { ...paymentPayload, accepted: wrongRequirements }, paymentRequirements: wrongRequirements };
  const rejected = await post('/settle', wrongBody);
  assert.equal(rejected.status, 400, `${field} should be rejected`);
}
assert.equal(await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] }), 0n);

const concurrent = await Promise.all([post('/settle', requestBody), post('/settle', requestBody)]);
const results = await Promise.all(concurrent.map(async (response) => ({ status: response.status, body: await response.json() })));
for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
assert(results.every((result) => result.body.success === true), JSON.stringify(results));
assert.equal(results[0].body.transaction, results[1].body.transaction, 'duplicate calls must return the same settlement identity');
const conflictingPayload = { ...paymentPayload, payload: { ...paymentPayload.payload, signature: `0x${'00'.repeat(65)}` } };
const conflictResponse = await post('/settle', { ...requestBody, paymentPayload: conflictingPayload });
assert.equal(conflictResponse.status, 409, 'same authorization with a changed payload must conflict');
const clientAfter = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [account.address] });
const cardAfter = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] });
assert.equal(clientAfter, 98_000_000n);
assert.equal(cardAfter, 2_000_000n);
const transferLogs = await publicClient.getLogs({ address: manifest.token, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), args: { from: account.address, to: manifest.agentCard }, fromBlock: firstBlock + 1n, toBlock: 'latest' });
assert.equal(transferLogs.length, 1);
assert.equal(transferLogs[0].args.value, 2_000_000n);

const gaslessPayloadResult = await paymentScheme.createPaymentPayload(2, requirements);
const gaslessPayload = { x402Version: 2, accepted: requirements, payload: gaslessPayloadResult.payload };
const gaslessBody = { x402Version: 2, paymentPayload: gaslessPayload, paymentRequirements: requirements };
const originalGas = await publicClient.getBalance({ address: manifest.facilitator });
async function setNativeBalance(value) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hardhat_setBalance', params: [manifest.facilitator, `0x${value.toString(16)}`] }) });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
}
await setNativeBalance(0n);
let noGasResponse;
try { noGasResponse = await post('/settle', gaslessBody); }
finally { await setNativeBalance(originalGas); }
const noGasResult = await noGasResponse.json();
assert.notEqual(noGasResult.success, true, JSON.stringify(noGasResult));
assert.equal(await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] }), 2_000_000n);
assert.equal(await publicClient.readContract({ ...token, functionName: 'authorizationState', args: [account.address, gaslessPayload.payload.authorization.nonce] }), false);

const cardArtifact = JSON.parse(fs.readFileSync('artifacts/contracts/AgentCard.sol/AgentCard.json', 'utf8'));
const card = { address: manifest.agentCard, abi: cardArtifact.abi };
let restoreHash = await ownerWallet.writeContract({ ...card, functionName: 'withdrawToken', args: [manifest.token, manifest.owner, 2_000_000n] });
await publicClient.waitForTransactionReceipt({ hash: restoreHash });
restoreHash = await ownerWallet.writeContract({ ...token, functionName: 'mint', args: [account.address, 2_000_000n] });
await publicClient.waitForTransactionReceipt({ hash: restoreHash });
const fixtureClient = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [account.address] });
const fixtureCard = await publicClient.readContract({ ...token, functionName: 'balanceOf', args: [manifest.agentCard] });
assert.equal(fixtureClient, 100_000_000n);
assert.equal(fixtureCard, 0n);
const report = { verifyReadOnly: true, supportedNetwork: `eip155:${manifest.chainId}`, concurrentResults: results.length, settlement: results[0].body, clientBalance: clientAfter.toString(), cardBalance: cardAfter.toString(), transferCount: transferLogs.length, missingGasRejected: noGasResult.success !== true, fixtureRestored: fixtureClient === 100_000_000n && fixtureCard === 0n };
fs.writeFileSync('evidence/M2-result.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
