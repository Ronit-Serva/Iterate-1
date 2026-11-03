import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { Task, TaskState } from '@a2a-js/sdk';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, SettleResponse, VerifyResponse } from '@x402/core/types';
import { EXTENSION, requirements, readCard } from '../../../packages/shared/src/card.js';
import { digest, durable, statePath, canonical } from '../../../packages/shared/src/store.js';
import { assertDeployment, type Deployment } from '../../../packages/shared/src/local.js';
import { confirmPayment } from '../../../packages/shared/src/receipt.js';
import { event } from '../../../packages/experiment/src/events.js';
import { executeSpecialist, validateRequest, type Assessment } from '../../../packages/llm/src/runtime.js';
export interface TaskRecord { id: string; contextId: string; runId: string; messageId: string; bodyHash: string; proofHash: string; credentialHash: string; authKey: string; payer: string; nonce: string; phase: string; state: TaskState; updatedAt: string; stagedResult?: Assessment; receipt?: SettleResponse; error?: string }
interface State { tasks: Record<string, TaskRecord>; messages: Record<string, string>; authorizations: Record<string, string>; executions: number }
export interface GateOptions { execute?: typeof executeSpecialist; facilitator?: <T>(route: string, payload: PaymentPayload, messageId: string) => Promise<T>; confirm?: typeof confirmPayment; file?: string }
export function publicTask(r: TaskRecord): Task {
  const completed = r.state === TaskState.TASK_STATE_COMPLETED && r.phase === 'delivered' && r.receipt?.success;
  return Task.fromJSON({ id: r.id, contextId: r.contextId, status: { state: r.state, timestamp: r.updatedAt }, history: [], artifacts: completed ? [{ artifactId: `result-${r.id}`, name: 'Specialist assessment', parts: [{ data: r.stagedResult, mediaType: 'application/json' }] }] : [], metadata: { phase: r.phase, messageId: r.messageId, ...(r.error ? { error: r.error } : {}), ...(r.receipt?.transaction ? { transaction: r.receipt.transaction } : {}) } });
}
export function createPaymentGate(config: Deployment, options: GateOptions = {}) {
  const store = durable<State>(options.file ?? statePath(config, 'tasks'), { tasks: {}, messages: {}, authorizations: {}, executions: 0 });
  const terms = requirements(config);
  // Restart is not recovery: never rerun a model or re-submit a proof.
  for (const r of Object.values(store.state.tasks)) if (![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED].includes(r.state)) { r.phase = 'unresolved'; r.error = 'Server interrupted; automatic resumption is disabled'; r.state = TaskState.TASK_STATE_UNSPECIFIED; }
  store.save();
  const execute = options.execute ?? executeSpecialist;
  const confirm = options.confirm ?? confirmPayment;
  const facilitator = options.facilitator ?? (async <T>(route: string, payload: PaymentPayload, messageId: string): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:4022/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-request-id': messageId }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: terms }), signal: AbortSignal.timeout(125_000) });
    if (!res.ok) throw new Error(`Facilitator ${route} HTTP ${res.status}`);
    return res.json() as Promise<T>;
  });
  const transition = (r: TaskRecord, phase: string, state: TaskState = TaskState.TASK_STATE_WORKING) => {
    r.phase = phase; r.state = state; r.updatedAt = new Date().toISOString(); store.save();
    event('agent2', phase, r.runId, { phase, state: TaskState[state], ...(r.receipt?.transaction ? { transaction: r.receipt.transaction } : {}) }, { messageId: r.messageId, taskId: r.id });
  };
  async function work(r: TaskRecord, request: { task: string }, proof: PaymentPayload) {
    try {
      transition(r, 'executing'); store.state.executions++; store.save();
      try { r.stagedResult = await execute(request, r.runId); }
      catch { r.error = 'Specialist execution failed or output was invalid; no settlement submitted'; transition(r, 'execution-failed', TaskState.TASK_STATE_FAILED); return; }
      transition(r, 'execution-succeeded'); // Durable private staging precedes any /settle.
      const auth = proof.payload.authorization as { validBefore: string };
      if (Number(auth.validBefore)*1000 <= Date.now()+5000) { r.error = 'Authorization expired after execution'; transition(r, 'settlement-failed', TaskState.TASK_STATE_FAILED); return; }
      transition(r, 'settling');
      let receipt: SettleResponse;
      try { receipt = await facilitator<SettleResponse>('settle', proof, r.messageId); }
      catch { r.error = 'Settlement response interrupted; payment outcome unknown'; transition(r, 'unresolved', TaskState.TASK_STATE_UNSPECIFIED); return; }
      r.receipt = receipt;
      if (!receipt.success && !['settlement_pending', 'settlement_unknown'].includes(receipt.errorReason ?? '')) { r.error = 'Settlement failed; result withheld'; transition(r, 'settlement-failed', TaskState.TASK_STATE_FAILED); return; }
      transition(r, 'settlement-pending');
      // Observe only the transaction already submitted. Never call /settle again.
      const deadline = Date.now()+30_000;
      while (true) {
        try { r.receipt = await confirm(config, receipt, r.payer, r.nonce); break; }
        catch { if (!receipt.transaction || Date.now() >= deadline) { r.error = 'Settlement confirmation unresolved'; transition(r, 'unresolved', TaskState.TASK_STATE_UNSPECIFIED); return; } await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      transition(r, 'settled');
      transition(r, 'delivered', TaskState.TASK_STATE_COMPLETED);
      // The assessment can enter the public activity stream only after the
      // independently confirmed payment opens the delivery gate.
      event('agent2', 'agent-text', r.runId, { output: r.stagedResult }, { messageId: r.messageId, taskId: r.id });
    } catch { r.error = 'Server execution interrupted'; transition(r, 'unresolved', TaskState.TASK_STATE_UNSPECIFIED); }
  }
  // Serialize acceptance only, never the background model/settlement work or polls.
  let acceptance = Promise.resolve();
  const middleware: RequestHandler = (req, res, next) => {
    const error = (status: number, message: string) => res.status(status).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32602, message } });
    const credential = req.header('x-task-access') ?? '';
    const credentialHash = digest(credential);
    const allowed = req.header('a2a-version') === '1.0' && req.header('a2a-extensions')?.split(',').map(s => s.trim()).includes(EXTENSION);
    if (!allowed) { error(400, 'A2A 1.0 and payment extension required'); return; }
    if (!/^[a-f0-9]{64}$/.test(credential)) { error(403, 'Task access credential required'); return; }
    res.set('A2A-Extensions', EXTENSION);
    if (req.body?.method === 'GetTask') {
      const r = store.state.tasks[req.body.params?.id];
      if (!r || r.credentialHash !== credentialHash) { error(404, 'Task not found'); return; }
      void assertDeployment(config).then(() => {
        if (r.phase === 'delivered' && r.receipt?.success) res.set('PAYMENT-RESPONSE', encodePaymentResponseHeader(r.receipt));
        event('server', 'task-read', r.runId, { method: 'GetTask', state: TaskState[r.state], phase: r.phase }, { messageId: r.messageId, taskId: r.id });
        next();
      }).catch(() => error(503, 'Deployment unavailable; task outcome unresolved'));
      return;
    }
    if (req.body?.method !== 'SendMessage') { error(400, 'Only SendMessage and GetTask are enabled'); return; }
    const operation = async () => {
      await readCard(config);
      const params = req.body.params; const message = params?.message; const id = message?.messageId;
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id ?? '') || message.role !== 'ROLE_USER' || message.taskId || message.contextId || message.referenceTaskIds?.length || params.configuration?.returnImmediately !== true || params.configuration?.taskPushNotificationConfig || params.tenant) { error(400, 'Expected standalone nonblocking SendMessage'); return; }
      const part = message.parts?.[0];
      if (message.parts?.length !== 1 || !part?.data) { error(400, 'Expected one structured task part'); return; }
      const request = validateRequest(part.data);
      const bodyHash = digest(params); const oldId = store.state.messages[id]; const old = oldId ? store.state.tasks[oldId] : undefined;
      if (old && (old.bodyHash !== bodyHash || old.credentialHash !== credentialHash)) { error(409, 'Request identity conflict'); return; }
      const raw = req.header('payment-signature');
      if (!raw) {
        event('server', 'challenge', req.header('x-experiment-run') ?? id, { method: 'SendMessage', status: 402, terms }, { messageId: id });
        res.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ x402Version: 2, resource: { url: 'http://127.0.0.1:4021', mimeType: 'application/json' }, accepts: [terms] }));
        res.status(402).json({ error: 'Payment required' }); return;
      }
      const proof = decodePaymentSignatureHeader(raw); const auth = proof.payload?.authorization as { from?: string; nonce?: string; validBefore?: string };
      if (proof.x402Version !== 2 || canonical(proof.accepted) !== canonical(terms) || !auth?.from || !auth.nonce || !auth.validBefore) { error(400, 'Invalid payment profile'); return; }
      const authKey = `${auth.from}:${auth.nonce}`.toLowerCase(); const proofHash = digest(proof);
      if (old) { if (old.proofHash !== proofHash) error(409, 'Payment conflict'); else next(); return; }
      if (store.state.authorizations[authKey]) { error(409, 'Authorization already bound'); return; }
      if (Number(auth.validBefore)*1000 < Date.now()+120_000) { error(400, 'Insufficient authorization lifetime'); return; }
      const verified = await facilitator<VerifyResponse>('verify', proof, id);
      if (!verified.isValid || verified.payer?.toLowerCase() !== auth.from.toLowerCase()) { error(402, 'Authorization verification failed'); return; }
      const runId = req.header('x-experiment-run') ?? id;
      const r: TaskRecord = { id: crypto.randomUUID(), contextId: crypto.randomUUID(), messageId: id, runId, bodyHash, proofHash, credentialHash, authKey, payer: auth.from, nonce: auth.nonce, phase: 'verified', state: TaskState.TASK_STATE_SUBMITTED, updatedAt: new Date().toISOString() };
      store.state.tasks[r.id] = r; store.state.messages[id] = r.id; store.state.authorizations[authKey] = id;
      transition(r, 'verified', TaskState.TASK_STATE_SUBMITTED);
      // SDK serializes the ack before the deferred worker can publish anything.
      next();
      setImmediate(() => void work(r, request, proof));
    };
    const current = acceptance.then(operation); acceptance = current.then(() => {}, () => {});
    void current.catch(() => { if (!res.headersSent) error(503, 'Request acceptance failed; outcome unresolved'); });
  };
  return { middleware, store, getExecutions: () => store.state.executions,
    getByMessage: (id: string) => { const r = store.state.tasks[store.state.messages[id]]; if (!r) throw new Error('Accepted task missing'); return publicTask(r); },
    getTask: (id: string) => { const r = store.state.tasks[id]; if (!r) throw new Error('Task missing'); return publicTask(r); } };
}
