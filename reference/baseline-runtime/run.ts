import fs from 'node:fs';
import crypto from 'node:crypto';
import { Message } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, assertDeployment, deployment } from '../../../packages/shared/src/local.js';
import { readCard, EXTENSION } from '../../../packages/shared/src/card.js';
import { paidFetch } from './payment.js';
import { checkpoint, emit } from '../../../packages/shared/src/walkthrough.js';
import { numbersFromMessage } from '../../../packages/shared/src/statistics.js';

export async function runPaid(numbers: number[] = [2, 4, 6], requestId: string = crypto.randomUUID()) {
  numbersFromMessage(Message.fromJSON({ role: 'ROLE_USER', parts: [{ data: { numbers } }] }));
  await checkpoint('client', 'read-card', requestId);
  const config = deployment();
  const chain = await assertDeployment(config);
  const card = await readCard(config);
  emit('client', 'card-read', requestId, { card, address: config.agentCard, anchor: config.anchor });
  const account = privateKeyToAccount(JSON.parse(fs.readFileSync('runtime/client-key.json', 'utf8')).privateKey);
  if (account.address.toLowerCase() !== config.client.toLowerCase()) throw new Error('Client key does not match fixture');
  const payment = paidFetch(card, config, account, fetch, requestId);
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: payment.fetchPayment })] });
  const client = await factory.createFromAgentCard(card);
  const token = { address: config.token, abi: artifact('TestUSD').abi };
  const balances = async () => ({ client: String(await chain.readContract({ ...token, functionName: 'balanceOf', args: [account.address] })), card: String(await chain.readContract({ ...token, functionName: 'balanceOf', args: [config.agentCard] })) });
  const before = await balances();
  emit('client', 'balances-before', requestId, before);
  await checkpoint('client', 'unpaid-request', requestId, { numbers });
  const result = await client.sendMessage({ tenant: '', message: Message.fromJSON({ messageId: requestId, role: 'ROLE_USER', parts: [{ data: { numbers }, mediaType: 'application/json' }] }), configuration: undefined, metadata: undefined }, { serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION)) });
  const output = { requestId, result, receipt: payment.state.receipt, challenges: payment.state.challenges, signatures: payment.state.signatures, before, after: await balances() };
  emit('client', 'result', requestId, output);
  return output;
}
