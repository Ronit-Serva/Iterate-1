import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Message } from '@a2a-js/sdk';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { createService } from '../apps/server/src/service.js';
import { EXTENSION } from '../packages/shared/src/card.js';

const service = await createService({ unpaidHarness: true });
const server = service.app.listen(4021, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
try {
  const remoteCard = await (await fetch('http://127.0.0.1:4021/.well-known/agent-card.json')).json();
  assert.deepEqual(remoteCard, service.card);
  const client = await new ClientFactory().createFromAgentCard(service.card);
  const request = (numbers: unknown) => ({ tenant: '', message: Message.fromJSON({ messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data: { numbers }, mediaType: 'application/json' }] }), configuration: undefined, metadata: undefined });
  await assert.rejects(client.sendMessage(request([2, 4, 6])), /extension/i);
  const options = { serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION)) };
  const result = await client.sendMessage(request([2, 4, 6]), options);
  assert('parts' in result);
  assert.deepEqual(result.parts[0].content, { $case: 'data', value: { count: 3, sum: 12, min: 2, max: 6, mean: 4 } });
  for (const invalid of [[], [null], [1, '2'], [1e20], Array(1001).fill(1)]) await assert.rejects(client.sendMessage(request(invalid), options));
  assert.equal(service.getExecutions(), 1);
  fs.writeFileSync('evidence/M4-result.json', JSON.stringify({ cardMatches: true, extensionActivationRequired: true, result, executions: service.getExecutions(), invalidInputsRejected: 5 }, null, 2) + '\n');
  console.log('M4 passed: SDK SendMessage, matching cards, required extension, statistics and five invalid-input cases.');
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
