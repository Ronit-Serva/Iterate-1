import { keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { artifact, assertDeployment, type Deployment } from './local.js';
import { validateCard } from './card.js';
export async function lookupAgent(config: Deployment) {
  const chain = await assertDeployment(config);
  const block = await chain.getBlock();
  const address = await chain.readContract({ address: config.registry, abi: artifact('AgentRegistry').abi, functionName: 'agents', args: [keccak256(stringToHex(config.agentKey))], blockNumber: block.number }) as Address;
  if (address === zeroAddress || address.toLowerCase() !== config.agentCard.toLowerCase()) throw new Error('Directory target missing or differs from pinned deployment');
  const contract = { address, abi: artifact('AgentCard').abi, blockNumber: block.number };
  if (!await chain.readContract({ ...contract, functionName: 'active' })) throw new Error('Agent inactive');
  const raw = await chain.readContract({ ...contract, functionName: 'cardJson' }) as string;
  return { card: validateCard(JSON.parse(raw), config), provenance: { registry: config.registry, agentKey: config.agentKey, cardAddress: address, blockNumber: block.number.toString(), blockHash: block.hash, cardHash: keccak256(stringToHex(raw)) } };
}
