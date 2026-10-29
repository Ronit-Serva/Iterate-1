import type { AgentCard } from '@a2a-js/sdk';
import type { PaymentRequirements } from '@x402/core/types';
import { artifact, assertDeployment, type Deployment } from './local.js';

export const EXTENSION = 'urn:local:a2a-x402:execute-before-settle:v1';
export function validateCard(value: unknown, config: Deployment): AgentCard {
  if (!value || typeof value !== 'object') throw new Error('Invalid AgentCard');
  const card = value as AgentCard;
  if (!card.name || !card.description || !card.version || !Array.isArray(card.supportedInterfaces)
    || !Array.isArray(card.skills) || !Array.isArray(card.defaultInputModes) || !Array.isArray(card.defaultOutputModes)
    || !card.securitySchemes || !Array.isArray(card.securityRequirements) || !Array.isArray(card.signatures)) throw new Error('Invalid A2A 1.0 card fields');
  const iface = card.supportedInterfaces.find(item => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0');
  if (!iface || new URL(iface.url).origin !== 'http://127.0.0.1:4021') throw new Error('Unsupported A2A interface');
  if (!card.skills.some(skill => skill.id === 'risk-assessment' && typeof skill.description === 'string' && Array.isArray(skill.tags))) throw new Error('Risk assessment skill missing');
  const extension = card.capabilities?.extensions.find(item => item.uri === EXTENSION);
  if (!extension?.required || !extension.params) throw new Error('Required payment extension missing');
  const terms = extension.params;
  if (terms.x402Version !== 2 || terms.scheme !== 'exact' || terms.network !== `eip155:${config.chainId}`
    || terms.asset?.toLowerCase() !== config.token.toLowerCase() || terms.amount !== '2000000'
    || terms.payTo?.toLowerCase() !== config.agentCard.toLowerCase()
    || terms.executionOrder !== 'verify-execute-settle-release' || terms.delivery !== 'task-polling'
    || terms.maxTimeoutSeconds !== 600) throw new Error('Card payment terms mismatch');
  return card;
}
export function requirements(config: Deployment): PaymentRequirements {
  return { scheme: 'exact', network: `eip155:${config.chainId}`, asset: config.token, amount: '2000000', payTo: config.agentCard,
    maxTimeoutSeconds: 600, extra: { name: 'TestUSD', version: '1', assetTransferMethod: 'eip3009' } };
}
export async function readCard(config: Deployment): Promise<AgentCard> {
  const client = await assertDeployment(config);
  const contract = { address: config.agentCard, abi: artifact('AgentCard').abi };
  if (!await client.readContract({ ...contract, functionName: 'active' })) throw new Error('AgentCard inactive');
  const json = await client.readContract({ ...contract, functionName: 'cardJson' });
  return validateCard(JSON.parse(json as string), config);
}
