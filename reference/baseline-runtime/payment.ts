import type { AgentCard } from '@a2a-js/sdk';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import type { LocalAccount } from 'viem';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { requirements } from '../../../packages/shared/src/card.js';
import type { Deployment } from '../../../packages/shared/src/local.js';
import { canonical } from '../../../packages/shared/src/store.js';
import { checkpoint, emit, emitTransient, walkthroughEnabled } from '../../../packages/shared/src/walkthrough.js';

export function checkChallenge(challenge: PaymentRequired, card: AgentCard, config: Deployment, budget = 2_000_000n) {
  const terms = requirements(config);
  if (challenge.x402Version !== 2 || challenge.resource.url !== card.supportedInterfaces[0].url || challenge.accepts.length !== 1
    || canonical(challenge.accepts[0]) !== canonical(terms) || BigInt(challenge.accepts[0].amount) > budget) throw new Error('Challenge differs from on-chain card or budget');
  return terms;
}
export function paidFetch(card: AgentCard, config: Deployment, account: LocalAccount, fetchImpl: typeof fetch = fetch, runId?: string) {
  const scheme = new ExactEvmScheme(toClientEvmSigner(account));
  const state: { signatures: number; challenges: number; receipt?: SettleResponse } = { signatures: 0, challenges: 0 };
  const fetchPayment: typeof fetch = async (input, init) => {
    if (walkthroughEnabled) init = { ...init, signal: AbortSignal.any([AbortSignal.timeout(240_000), ...(init?.signal ? [init.signal] : [])]) };
    emit('client', 'unpaid-request', runId, { endpoint: String(input), body: init?.body });
    let response = await fetchImpl(input, init);
    if (response.status === 402 && response.headers.get('payment-required')) {
      state.challenges++;
      const challenge = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
      emit('client', 'challenge', runId, { status: response.status, challenge });
      const terms = checkChallenge(challenge, card, config);
      emit('client', 'terms-validated', runId, terms);
      await checkpoint('client', 'authorize', runId ?? '', terms);
      const created = await scheme.createPaymentPayload(2, terms);
      const payload: PaymentPayload = { x402Version: 2, accepted: terms, payload: created.payload };
      state.signatures++;
      if (runId) emitTransient('payment-payload', runId, payload);
      emit('client', 'signed', runId, { message: 'EIP-3009 payment payload created in client memory.' });
      await checkpoint('client', 'paid-retry', runId ?? '', { signatureCreated: true });
      const authorization = payload.payload.authorization as { validBefore?: string };
      if (authorization.validBefore && Number(authorization.validBefore) * 1000 <= Date.now()) throw new Error('Authorization expired before submission. This attempt was not submitted; begin a new walkthrough.');
      const headers = new Headers(init?.headers);
      headers.set('PAYMENT-SIGNATURE', encodePaymentSignatureHeader(payload));
      emit('client', 'paid-retry', runId, { endpoint: String(input) });
      response = await fetchImpl(input, { ...init, headers, ...(walkthroughEnabled ? { signal: AbortSignal.timeout(240_000) } : {}) });
    }
    const receipt = response.headers.get('payment-response');
    if (receipt) state.receipt = decodePaymentResponseHeader(receipt);
    return response;
  };
  return { fetchPayment, state };
}
