import crypto from 'node:crypto';
import fs from 'node:fs';
import { Message, SendMessageConfiguration, TaskState, type AgentCard, type Task, type SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { privateKeyToAccount } from 'viem/accounts';
import { deployment, artifact, assertDeployment } from '../../../packages/shared/src/local.js';
import { EXTENSION, requirements } from '../../../packages/shared/src/card.js';
import { lookupAgent } from '../../../packages/shared/src/registry.js';
import { canonical } from '../../../packages/shared/src/store.js';
import { confirmPayment } from '../../../packages/shared/src/receipt.js';
import { event, type RunRecord } from '../../../packages/experiment/src/events.js';
import { validateRequest, validateAssessment } from '../../../packages/llm/src/runtime.js';
import type { ToolSpec } from '../../../packages/llm/src/provider.js';
export class Unresolved extends Error {}
export class DelegationFailed extends Error {}
const descriptions: Record<string, string> = {
  lookup_agent_card: 'Discover the specialist by reading the configured local blockchain directory and AgentCard.',
  request_agent: 'Delegate a specialist task to the discovered agent using A2A SendMessage. Usually returns a payment challenge reference.',
  verify_payment_challenge: 'Validate the received HTTP 402 payment terms against the discovered card and fixed two-TestUSD budget.',
  sign_payment: 'Create one isolated host-held payment authorization for the validated terms. Returns only a public summary.',
  retry_with_payment: 'Retry the identical A2A request using the signed host-held authorization, then poll its Task with GetTask. Return specialist output only after settlement confirmation.'
};
export const toolSpecs: ToolSpec[] = Object.entries(descriptions).map(([name, description]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: name === 'request_agent' ? { task: { type: 'string', description: 'Self-contained delegated task with all relevant approaches, priorities and constraints.' } } : {}, required: name === 'request_agent' ? ['task'] : [], additionalProperties: false } } }));
export function createTools(run: RunRecord, save: () => void, options: { pollMs?: number; deadlineMs?: number } = {}) {
  const config = deployment();
  const credential = crypto.randomBytes(32).toString('hex');
  let phase = 'new'; let card: AgentCard; let challenge: PaymentRequired | undefined; let proof: PaymentPayload | undefined; let receipt: SettleResponse | undefined;
  let client: Awaited<ReturnType<ClientFactory['createFromAgentCard']>>;
  let params: SendMessageRequest;
  const messageId = crypto.randomUUID(); run.messageId = messageId; save();
  const serviceParameters = ServiceParameters.create(withA2AExtensions(EXTENSION));
  const emit = (type: string, data: Record<string, unknown> = {}) => event('agent1', type, run.id, data, { messageId, taskId: run.taskId });
  const transportFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers); headers.set('x-task-access', credential); headers.set('x-experiment-run', run.id);
    const body = JSON.parse(String(init?.body ?? '{}')); const method = body.method;
    if (method === 'SendMessage' && phase === 'signed') headers.set('PAYMENT-SIGNATURE', encodePaymentSignatureHeader(proof!));
    const res = await fetch(input, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (method === 'SendMessage' && phase === 'discovered' && res.status === 402 && res.headers.has('payment-required')) challenge = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
    if (method === 'GetTask' && res.headers.has('payment-response')) receipt = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    return res;
  };
  async function balances() {
    const chain = await assertDeployment(config); const token = { address: config.token, abi: artifact('TestUSD').abi };
    return { client: String(await chain.readContract({ ...token, functionName: 'balanceOf', args: [config.client] })), card: String(await chain.readContract({ ...token, functionName: 'balanceOf', args: [config.agentCard] })) };
  }
  const requirePhase = (expected: string) => { if (phase !== expected) throw new Error(`Tool requires phase ${expected}; current phase is ${phase}`); };
  const methods: Record<string, (args: any) => Promise<unknown>> = {
    async lookup_agent_card() {
      requirePhase('new'); const found = await lookupAgent(config); card = found.card; run.provenance = found.provenance; run.before = await balances(); save();
      client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: transportFetch })] }).createFromAgentCard(card);
      phase = 'discovered'; emit('directory-discovered', { card, provenance: found.provenance, before: run.before }); return { card, provenance: found.provenance };
    },
    async request_agent(args) {
      requirePhase('discovered'); const request = validateRequest(args);
      params = { tenant: '', message: Message.fromJSON({ messageId, role: 'ROLE_USER', parts: [{ data: request, mediaType: 'application/json' }] }), configuration: SendMessageConfiguration.fromJSON({ returnImmediately: true, historyLength: 0 }), metadata: undefined };
      emit('unpaid-request', { method: 'SendMessage', request });
      try { await client.sendMessage(params, { serviceParameters }); }
      catch { if (!challenge) throw new Unresolved('Initial delegation interrupted without a valid challenge'); }
      if (!challenge) throw new DelegationFailed('Server failed to require payment');
      phase = 'challenged'; emit('payment-challenge', { status: 402, terms: challenge.accepts }); return { status: 402, challengeReference: messageId, terms: challenge.accepts };
    },
    async verify_payment_challenge() {
      requirePhase('challenged'); const terms = requirements(config);
      if (!challenge || challenge.x402Version !== 2 || challenge.resource.url !== card.supportedInterfaces[0].url || challenge.accepts.length !== 1 || canonical(challenge.accepts[0]) !== canonical(terms) || BigInt(terms.amount) > 2_000_000n) throw new DelegationFailed('Challenge differs from card or budget');
      phase = 'validated'; emit('challenge-validated', { terms }); return { validated: true, amount: terms.amount, asset: terms.asset, payTo: terms.payTo, network: terms.network };
    },
    async sign_payment() {
      requirePhase('validated');
      const account = privateKeyToAccount(JSON.parse(fs.readFileSync('runtime/client-key.json', 'utf8')).privateKey);
      if (account.address.toLowerCase() !== config.client.toLowerCase()) throw new Error('Client signer differs from fixture');
      const terms = requirements(config); const signed = await new ExactEvmScheme(toClientEvmSigner(account)).createPaymentPayload(2, terms);
      proof = { x402Version: 2, accepted: terms, payload: signed.payload };
      const auth = proof.payload.authorization as { nonce: string; validBefore: string };
      phase = 'signed'; emit('authorization-created', { payer: account.address, nonce: auth.nonce, validBefore: auth.validBefore, amount: terms.amount });
      return { signed: true, sessionHandle: messageId, amount: terms.amount, network: terms.network, validBefore: auth.validBefore };
    },
    async retry_with_payment() {
      requirePhase('signed'); emit('paid-retry', { method: 'SendMessage' });
      const deadline = Date.now()+(options.deadlineMs ?? 240_000);
      let task: Task;
      try {
        const ack = await client.sendMessage(params, { serviceParameters });
        if (!('status' in ack) || !('id' in ack)) throw new Error('Expected A2A Task acknowledgement');
        task = ack as Task; run.taskId = task.id; save(); phase = 'polling';
        emit('task-acknowledged', { state: TaskState[task.status!.state], response: { id: task.id, contextId: task.contextId } });
        let poll = 0;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, options.pollMs ?? Math.min(2000+poll*250, 4000)));
          task = await client.getTask({ tenant: '', id: run.taskId, historyLength: 0 }, { serviceParameters });
          if (typeof task.metadata?.transaction === 'string') { run.transaction = task.metadata.transaction; save(); }
          emit('task-poll', { method: 'GetTask', poll: ++poll, state: TaskState[task.status!.state], phase: task.metadata?.phase });
          const state = task.status?.state;
          if (state === TaskState.TASK_STATE_COMPLETED) {
            if (!receipt?.success || !proof) throw new Error('Completed task has no successful receipt');
            const auth = proof.payload.authorization as { from: string; nonce: string };
            run.receipt = await confirmPayment(config, receipt, auth.from, auth.nonce); run.transaction = receipt.transaction;
            const part = task.artifacts?.[0]?.parts?.[0];
            const assessment = validateAssessment(part?.content?.$case === 'data' ? part.content.value : undefined);
            run.assessment = assessment; run.after = await balances(); phase = 'completed'; save();
            emit('result-received', { output: assessment, receipt: run.receipt, transaction: receipt.transaction, after: run.after });
            return { taskId: task.id, assessment, transaction: receipt.transaction, receiptVerified: true };
          }
          if ([TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED].includes(state!)) throw new DelegationFailed(`Delegation failed: ${task.metadata?.error ?? task.metadata?.phase ?? TaskState[state!]}`);
          if ([TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_UNSPECIFIED].includes(state!)) throw new Unresolved('Delegation interrupted; outcome unresolved');
        }
        throw new Unresolved('Task polling deadline exceeded; outcome unresolved');
      } catch (error) { phase = 'stopped'; if (error instanceof DelegationFailed || error instanceof Unresolved) throw error; throw new Unresolved('Paid submission or task polling interrupted; no automatic retry'); }
      finally { proof = undefined; }
    }
  };
  return { get phase() { return phase; }, async invoke(name: string, args: unknown) {
    if (!methods[name]) throw new Error('Unknown tool');
    if (!args || typeof args !== 'object' || Object.keys(args).some(k => name !== 'request_agent' || k !== 'task')) throw new Error('Invalid tool arguments');
    emit('tool-start', { tool: name, ...(name === 'request_agent' ? { input: args } : {}) });
    const result = await methods[name](args); emit('tool-end', { tool: name, status: 'completed' }); return result;
  } };
}
