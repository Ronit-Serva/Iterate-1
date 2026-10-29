import { decodeEventLog, type Hex } from 'viem';
import type { SettleResponse } from '@x402/core/types';
import { artifact, assertDeployment, type Deployment } from './local.js';
export async function confirmPayment(config: Deployment, receipt: SettleResponse, payer: string, nonce: string) {
  if (!receipt.transaction || receipt.network !== `eip155:${config.chainId}` || receipt.payer?.toLowerCase() !== payer.toLowerCase()) throw new Error('Invalid settlement receipt');
  const chain = await assertDeployment(config);
  const r = await chain.getTransactionReceipt({ hash: receipt.transaction as Hex });
  if (r.status !== 'success') throw new Error('Settlement reverted');
  const events = r.logs.filter(l => l.address.toLowerCase() === config.token.toLowerCase()).flatMap(l => {
    try { return [decodeEventLog({ abi: artifact('TestUSD').abi, data: l.data, topics: l.topics }) as any]; } catch { return []; }
  });
  if (!events.some(e => e.eventName === 'Transfer' && e.args.from.toLowerCase() === payer.toLowerCase() && e.args.to.toLowerCase() === config.agentCard.toLowerCase() && e.args.value === 2_000_000n)
    || !events.some(e => e.eventName === 'AuthorizationUsed' && e.args.authorizer.toLowerCase() === payer.toLowerCase() && e.args.nonce.toLowerCase() === nonce.toLowerCase())) throw new Error('Settlement events mismatch');
  return { ...receipt, success: true, blockNumber: r.blockNumber.toString(), blockHash: r.blockHash };
}
