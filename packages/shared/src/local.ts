import fs from 'node:fs';
import { createPublicClient, defineChain, http, keccak256, type Abi, type Address, type Hex } from 'viem';

export interface Deployment {
  chainId: number; rpcUrl: string; token: Address; agentCard: Address; owner: Address;
  registry: Address; agentKey: string; client: Address; facilitator: Address; anchor: { blockNumber: string; blockHash: Hex };
  tokenDomain: { name: string; version: string; decimals: number };
  codeHashes: { token: Hex; agentCard: Hex; registry: Hex };
}
export function deployment(): Deployment {
  return JSON.parse(fs.readFileSync('deployments/local.json', 'utf8'));
}
export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(fs.readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
}
export function chainClient(config: Deployment) {
  const rpc = new URL(config.rpcUrl);
  if (!['127.0.0.1', 'localhost'].includes(rpc.hostname) || config.chainId !== 31337) throw new Error('Only the local chain is supported');
  const chain = defineChain({ id: config.chainId, name: 'Hardhat Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  return createPublicClient({ chain, transport: http(config.rpcUrl) });
}
export async function assertDeployment(config: Deployment) {
  const client = chainClient(config);
  if (await client.getChainId() !== config.chainId) throw new Error('Wrong chain');
  for (const name of ['token', 'agentCard', 'registry'] as const) {
    const code = await client.getCode({ address: config[name] });
    if (!code || code === '0x') throw new Error(`${name} contract is missing`);
    if (keccak256(code) !== config.codeHashes[name]) throw new Error(`${name} bytecode mismatch`);
  }
  try {
    const block = await client.getBlock({ blockNumber: BigInt(config.anchor.blockNumber) });
    if (block.hash !== config.anchor.blockHash) throw new Error('Stale deployment after chain reset');
  } catch { throw new Error('Stale deployment after chain reset'); }
  return client;
}
