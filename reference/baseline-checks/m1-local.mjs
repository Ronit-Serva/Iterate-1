import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, parseSignature, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const rpc = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
if (!['127.0.0.1', 'localhost'].includes(new URL(rpc).hostname)) throw new Error('Only loopback RPC is supported');
const chain = defineChain({ id: 31337, name: 'Hardhat Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const publicClient = createPublicClient({ chain, transport: http(rpc) });
assert.equal(await publicClient.getChainId(), 31337, 'Only the local development chain is supported');
const [owner, _unused, unauthorized] = await publicClient.request({ method: 'eth_accounts' });
if (!owner || !unauthorized) throw new Error('Hardhat local accounts unavailable');
const facilitatorPrivateKey = generatePrivateKey();
const facilitatorAccount = privateKeyToAccount(facilitatorPrivateKey);
const facilitator = facilitatorAccount.address;
fs.mkdirSync('runtime', { recursive: true, mode: 0o700 });
fs.writeFileSync('runtime/facilitator-key.json', JSON.stringify({ privateKey: facilitatorPrivateKey }), { mode: 0o600 });
const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc) });
const facilitatorWallet = createWalletClient({ account: facilitatorAccount, chain, transport: http(rpc) });
const unauthorizedWallet = createWalletClient({ account: unauthorized, chain, transport: http(rpc) });
const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await ownerWallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return { address: receipt.contractAddress, abi: a.abi };
}

const counter = await deploy('Counter');
const counterContract = { address: counter.address, abi: counter.abi };
let hash = await ownerWallet.writeContract({ ...counterContract, functionName: 'increment' });
await publicClient.waitForTransactionReceipt({ hash });
assert.equal(await publicClient.readContract({ ...counterContract, functionName: 'count' }), 1n);

const token = await deploy('TestUSD', [owner]);
const tokenContract = { address: token.address, abi: token.abi };
const card = await deploy('AgentCard', [owner, '{}', true]);
const cardValue = {
  name: 'Local Statistics Agent',
  description: 'Computes count, sum, minimum, maximum, and mean for a finite list of numbers.',
  supportedInterfaces: [{ url: 'http://127.0.0.1:4021', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
  provider: { organization: 'Local Prototype', url: 'http://127.0.0.1' },
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [{ uri: 'https://example.org/a2a/x402', description: 'Exact EVM payment settled before the statistics task runs.', required: true, params: { x402Version: 2, scheme: 'exact', network: `eip155:${chain.id}`, asset: token.address, amount: '2000000', payTo: card.address } }] },
  securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
  skills: [{ id: 'statistics', name: 'Statistics', description: 'Calculate summary statistics for a small number array.', tags: ['statistics'], examples: ['Calculate statistics for [2, 4, 6]'], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [] }],
  signatures: [],
};
const cardJson = JSON.stringify(cardValue);
hash = await ownerWallet.writeContract({ address: card.address, abi: card.abi, functionName: 'updateCard', args: [cardJson, true] });
await publicClient.waitForTransactionReceipt({ hash });
const clientPrivateKey = generatePrivateKey();
const fundingHash = await ownerWallet.sendTransaction({ to: facilitator, value: 1_000_000_000_000_000_000n });
assert.equal((await publicClient.waitForTransactionReceipt({ hash: fundingHash })).status, 'success');
const clientAccount = privateKeyToAccount(clientPrivateKey);
fs.mkdirSync('runtime', { recursive: true, mode: 0o700 });
fs.writeFileSync('runtime/client-key.json', JSON.stringify({ privateKey: clientPrivateKey }), { mode: 0o600 });
const initialBalance = 100_000_000n;
hash = await ownerWallet.writeContract({ ...tokenContract, functionName: 'mint', args: [clientAccount.address, initialBalance] });
await publicClient.waitForTransactionReceipt({ hash });
const ordinaryRecipient = privateKeyToAccount(generatePrivateKey()).address;
hash = await ownerWallet.writeContract({ ...tokenContract, functionName: 'mint', args: [owner, 1_000_000n] });
await publicClient.waitForTransactionReceipt({ hash });
hash = await ownerWallet.writeContract({ ...tokenContract, functionName: 'transfer', args: [ordinaryRecipient, 1_000_000n] });
const ordinaryReceipt = await publicClient.waitForTransactionReceipt({ hash });
assert.equal(ordinaryReceipt.status, 'success');
assert.equal(ordinaryReceipt.logs.length, 1);
assert.equal(await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [clientAccount.address] }), 100_000_000n);
assert.equal(await publicClient.getBalance({ address: clientAccount.address }), 0n);

const domain = { name: 'TestUSD', version: '1', chainId: 31337, verifyingContract: token.address };
const types = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };
const now = BigInt(Math.floor(Date.now() / 1000));
async function authorization(value, options = {}) {
  const nonce = options.nonce ?? `0x${crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const validAfter = options.validAfter ?? now - 60n;
  const validBefore = options.validBefore ?? now + 600n;
  const message = { from: clientAccount.address, to: card.address, value, validAfter, validBefore, nonce };
  const signer = options.signer ?? clientAccount;
  const signature = parseSignature(await signer.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message }));
  return { args: [message.from, message.to, value, validAfter, validBefore, nonce, signature.v, signature.r, signature.s], nonce };
}
const beforeOwnerEth = await publicClient.getBalance({ address: facilitator });
const auth = await authorization(2_000_000n);
hash = await facilitatorWallet.writeContract({ ...tokenContract, functionName: 'transferWithAuthorization', args: auth.args });
const paidReceipt = await publicClient.waitForTransactionReceipt({ hash });
assert.equal(paidReceipt.status, 'success');
const paymentEvent = paidReceipt.logs.map(log => decodeEventLog({ abi: tokenContract.abi, data: log.data, topics: log.topics })).find(event => event.eventName === 'Transfer');
assert(paymentEvent);
assert.equal(paymentEvent.eventName, 'Transfer');
assert.equal(paymentEvent.args.from.toLowerCase(), clientAccount.address.toLowerCase());
assert.equal(paymentEvent.args.to.toLowerCase(), card.address.toLowerCase());
assert.equal(paymentEvent.args.value, 2_000_000n);
assert.equal(await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [clientAccount.address] }), 98_000_000n);
assert.equal(await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [card.address] }), 2_000_000n);
assert.equal(await publicClient.readContract({ ...tokenContract, functionName: 'authorizationState', args: [clientAccount.address, auth.nonce] }), true);

async function expectRevert(operation) {
  let failed = false;
  try { await operation(); } catch (error) { assert.match(error.message, /revert/i); failed = true; }
  assert.equal(failed, true, 'expected transaction to revert');
}
const replay = await authorization(2_000_000n, { nonce: auth.nonce });
await expectRevert(async () => {
  const tx = await facilitatorWallet.writeContract({ ...tokenContract, functionName: 'transferWithAuthorization', args: replay.args });
  await publicClient.waitForTransactionReceipt({ hash: tx });
});
const expired = await authorization(2_000_000n, { validBefore: now - 1n });
await expectRevert(async () => {
  const tx = await facilitatorWallet.writeContract({ ...tokenContract, functionName: 'transferWithAuthorization', args: expired.args });
  await publicClient.waitForTransactionReceipt({ hash: tx });
});
const forged = await authorization(2_000_000n, { signer: privateKeyToAccount(generatePrivateKey()) });
await expectRevert(async () => {
  const tx = await facilitatorWallet.writeContract({ ...tokenContract, functionName: 'transferWithAuthorization', args: forged.args });
  await publicClient.waitForTransactionReceipt({ hash: tx });
});
const tooLarge = await authorization(99_000_001n);
await expectRevert(async () => {
  const tx = await facilitatorWallet.writeContract({ ...tokenContract, functionName: 'transferWithAuthorization', args: tooLarge.args });
  await publicClient.waitForTransactionReceipt({ hash: tx });
});
await expectRevert(async () => {
  const tx = await unauthorizedWallet.writeContract({ ...tokenContract, functionName: 'mint', args: [clientAccount.address, 1n] });
  await publicClient.waitForTransactionReceipt({ hash: tx });
});
const paidClient = await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [clientAccount.address] });
const paidCard = await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [card.address] });
assert.equal(paidClient, 98_000_000n);
assert.equal(paidCard, 2_000_000n);
const afterOwnerEth = await publicClient.getBalance({ address: facilitator });
assert(afterOwnerEth < beforeOwnerEth, 'facilitator should pay gas');
hash = await ownerWallet.writeContract({ address: card.address, abi: card.abi, functionName: 'withdrawToken', args: [token.address, owner, 2_000_000n] });
await publicClient.waitForTransactionReceipt({ hash });
hash = await ownerWallet.writeContract({ ...tokenContract, functionName: 'mint', args: [clientAccount.address, 2_000_000n] });
const anchor = await publicClient.waitForTransactionReceipt({ hash });
const fixtureClient = await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [clientAccount.address] });
const fixtureCard = await publicClient.readContract({ ...tokenContract, functionName: 'balanceOf', args: [card.address] });
assert.equal(fixtureClient, 100_000_000n);
assert.equal(fixtureCard, 0n);
const manifest = { chainId: await publicClient.getChainId(), rpcUrl: rpc, counter: counter.address, token: token.address, agentCard: card.address, owner, client: clientAccount.address, facilitator, fixtureClientBalance: fixtureClient.toString(), fixtureCardBalance: fixtureCard.toString(), settledClientBalance: paidClient.toString(), settledCardBalance: paidCard.toString(), paymentTxHash: paidReceipt.transactionHash, receiptStatus: paidReceipt.status };
manifest.anchor = { blockNumber: anchor.blockNumber.toString(), blockHash: anchor.blockHash };
manifest.tokenDomain = { name: 'TestUSD', version: '1', decimals: 6 };
manifest.codeHashes = { token: keccak256(await publicClient.getCode({ address: token.address })), agentCard: keccak256(await publicClient.getCode({ address: card.address })) };
fs.mkdirSync('deployments', { recursive: true });
fs.writeFileSync('deployments/local.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ...manifest, facilitatorPaidGas: afterOwnerEth < beforeOwnerEth, fixtureRestored: true }, null, 2));
