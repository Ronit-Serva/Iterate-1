import fs from 'node:fs';
import { createWalletClient, http, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainClient, artifact } from '../packages/shared/src/local.ts';
const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const client = chainClient({ rpcUrl, chainId: 31337 });
if (await client.getChainId() !== 31337) throw new Error('Local chain required');
const [owner] = await client.request({ method: 'eth_accounts' });
const wallet = createWalletClient({ account: owner, chain: client.chain, transport: http(rpcUrl) });
async function confirmed(hash) { const r = await client.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('Transaction reverted'); return r; }
async function deploy(name, args) { const a = artifact(name); return (await confirmed(await wallet.deployContract({ ...a, args }))).contractAddress; }
const token = await deploy('TestUSD', [owner]);
const agentCard = await deploy('AgentCard', [owner, '{}', true]);
const registry = await deploy('AgentRegistry', [owner]);
const terms = { x402Version: 2, scheme: 'exact', network: 'eip155:31337', asset: token, amount: '2000000', payTo: agentCard, executionOrder: 'verify-execute-settle-release', delivery: 'task-polling', maxTimeoutSeconds: 600 };
const card = { name: 'Tradeoff Specialist', description: 'LLM specialist assessing supplied approaches, risks and tradeoffs.', supportedInterfaces: [{ url: 'http://127.0.0.1:4021', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }], version: '1.0.0', capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [{ uri: 'urn:local:a2a-x402:execute-before-settle:v1', required: true, description: 'Verify authorization, execute and privately stage, settle and confirm, then publish via GetTask. Completed polls include PAYMENT-RESPONSE. Task reads require X-Task-Access.', params: terms }] }, securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: [{ id: 'risk-assessment', name: 'Risk assessment', description: 'Assess user-supplied approaches against constraints; return summary, tradeoffs, risks and limitations.', tags: ['analysis', 'tradeoffs'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [] }], signatures: [] };
await confirmed(await wallet.writeContract({ address: agentCard, abi: artifact('AgentCard').abi, functionName: 'updateCard', args: [JSON.stringify(card), true] }));
const agentKey = 'tradeoff-specialist';
await confirmed(await wallet.writeContract({ address: registry, abi: artifact('AgentRegistry').abi, functionName: 'register', args: [keccak256(stringToHex(agentKey)), agentCard] }));
fs.mkdirSync('runtime', { recursive: true, mode: 0o700 });
const accounts = {};
for (const role of ['client', 'facilitator']) {
  const privateKey = generatePrivateKey(); const account = privateKeyToAccount(privateKey); accounts[role] = account.address;
  fs.writeFileSync(`runtime/${role}-key.json`, JSON.stringify({ privateKey }), { mode: 0o600 });
}
await confirmed(await wallet.sendTransaction({ to: accounts.facilitator, value: 10n ** 18n }));
const anchor = await confirmed(await wallet.writeContract({ address: token, abi: artifact('TestUSD').abi, functionName: 'mint', args: [accounts.client, 100_000_000n] }));
const codeHashes = {};
for (const [name, address] of Object.entries({ token, agentCard, registry })) codeHashes[name] = keccak256(await client.getCode({ address }));
const manifest = { chainId: 31337, rpcUrl, token, agentCard, registry, agentKey, owner, ...accounts, anchor: { blockNumber: anchor.blockNumber.toString(), blockHash: anchor.blockHash }, codeHashes, tokenDomain: { name: 'TestUSD', version: '1', decimals: 6 } };
fs.mkdirSync('deployments', { recursive: true }); fs.writeFileSync('deployments/local.json', JSON.stringify(manifest, null, 2)+'\n');
console.log(JSON.stringify({ deployed: true, ...manifest }, null, 2));
