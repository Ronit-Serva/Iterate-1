import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWalletClient, http } from 'viem';
import { artifact, assertDeployment, deployment } from '../packages/shared/src/local.js';
import { readCard } from '../packages/shared/src/card.js';

const config = deployment();
const client = await assertDeployment(config);
const accounts = await createWalletClient({ chain: client.chain, transport: http(config.rpcUrl) }).getAddresses();
const strangerAddress = accounts[2];
assert(strangerAddress);
const owner = createWalletClient({ account: config.owner, chain: client.chain, transport: http(config.rpcUrl) });
const stranger = createWalletClient({ account: strangerAddress, chain: client.chain, transport: http(config.rpcUrl) });
const cardContract = { address: config.agentCard, abi: artifact('AgentCard').abi };
const token = { address: config.token, abi: artifact('TestUSD').abi };
const card = await readCard(config);
async function write(functionName: string, args: unknown[]) {
  const hash = await owner.writeContract({ ...cardContract, functionName, args });
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
}
await assert.rejects(readCard({ ...config, chainId: 1 }), /local chain|Wrong chain/);
await assert.rejects(readCard({ ...config, agentCard: '0x0000000000000000000000000000000000000001' }), /missing/);
await assert.rejects(stranger.writeContract({ ...cardContract, functionName: 'updateCard', args: ['{}', false] }), /revert/i);
const changed = { ...card, description: `${card.description} Owner update checked.` };
try {
  await write('updateCard', [JSON.stringify(changed), true]);
  assert.equal((await readCard(config)).description, changed.description);
  await write('updateCard', [JSON.stringify(card), false]);
  await assert.rejects(readCard(config), /inactive/);
} finally { await write('updateCard', [JSON.stringify(card), true]); }
const initial = await client.readContract({ ...token, functionName: 'balanceOf', args: [config.agentCard] }) as bigint;
let hash = await owner.writeContract({ ...token, functionName: 'mint', args: [config.agentCard, 1_000_000n] });
await client.waitForTransactionReceipt({ hash });
await assert.rejects(stranger.writeContract({ ...cardContract, functionName: 'withdrawToken', args: [config.token, accounts[2], 1_000_000n] }), /revert/i);
assert.equal(await client.readContract({ ...token, functionName: 'balanceOf', args: [config.agentCard] }), initial + 1_000_000n);
const beforeOwner = await client.readContract({ ...token, functionName: 'balanceOf', args: [config.owner] }) as bigint;
await write('withdrawToken', [config.token, config.owner, 1_000_000n]);
assert.equal(await client.readContract({ ...token, functionName: 'balanceOf', args: [config.agentCard] }), initial);
assert.equal(await client.readContract({ ...token, functionName: 'balanceOf', args: [config.owner] }), beforeOwner + 1_000_000n);
const result = { chainId: config.chainId, agentCard: config.agentCard, card: await readCard(config), checks: ['known-address retrieval', 'wrong chain', 'missing contract', 'inactive card', 'owner update', 'unauthorized update', 'owner withdrawal', 'unauthorized withdrawal'] };
fs.writeFileSync('evidence/M3-result.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
