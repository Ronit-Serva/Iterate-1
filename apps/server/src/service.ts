import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { deployment, assertDeployment } from '../../../packages/shared/src/local.js';
import { readCard } from '../../../packages/shared/src/card.js';
import { createPaymentGate, type GateOptions } from './payment-gate.js';
export async function createService(options: GateOptions = {}) {
  const config = deployment(); const card = await readCard(config);
  const gate = createPaymentGate(config, options);
  // Default handler provides SDK card/transport integration only. Both supported
  // methods are overridden with the durable, payment-aware task store below.
  const executor: AgentExecutor = { async execute() { throw new Error('Direct executor disabled'); }, async cancelTask() { throw new Error('Cancellation disabled'); } };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  handler.sendMessage = async params => gate.getByMessage(params.message!.messageId);
  handler.getTask = async params => gate.getTask(params.id);
  const sdkHandler = jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication });
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '64kb' }));
  app.get('/health', async (_req, res) => { try { await assertDeployment(config); res.json({ ok: true, anchor: config.anchor, executions: gate.getExecutions(), mode: 'verify-execute-settle-release' }); } catch { res.status(503).json({ ok: false }); } });
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.post('/', gate.middleware, sdkHandler);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: 'Malformed request' }));
  return { app, card, gate, getExecutions: gate.getExecutions };
}
