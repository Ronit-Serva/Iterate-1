# Iterate #1 — Relay agent experiment

Two cloud LLM agents discover and delegate through A2A 1.0 JSON-RPC with a modified local x402 v2 payment gate. Agent 1 signs one authorization; Agent 2 verifies it, executes and privately stages an assessment, settles, independently confirms the transfer, then publishes an A2A Task artifact. Agent 1 polls `GetTask` and feeds the delivered assessment into its final model call.

Run from this directory using Node 22.23+ (see `.nvmrc`):

```sh
npm ci
cp .env.example .env
chmod 600 .env
# Set NVIDIA_API_KEY locally in .env.
npm start
```

Open **http://127.0.0.1:4030**. The dashboard shows both agents, model-call durations and token counts, real tool calls, on-chain discovery, A2A requests/polls, payment phases, balances, the final response, and a public event inspector. Start one experiment at a time. Export evidence from its run entry. No simulated activity is shown.

`npm start` compiles contracts, owns a fresh chain on 8545, creates fresh local client/facilitator keys, deploys TestUSD/AgentCard/AgentRegistry, starts the facilitator on 4022, Agent 2 on 4021, and dashboard on 4030. It refuses occupied ports. Ctrl+C stops its owned services. Each new startup creates a new fixture; previous evidence is historical and does not verify against a replacement chain.

Cloud defaults are `https://integrate.api.nvidia.com/v1` and `nvidia/nemotron-3.5-lightning-30b-a3b` for both agents. `AGENT1_MODEL` and `AGENT2_MODEL` override `LLM_MODEL`; `LLM_API_KEY` overrides `NVIDIA_API_KEY`. Credentials stay in server processes, never in browser responses or either model's tool transcript. The adapter uses OpenAI-compatible `/chat/completions`, temperature 1 and top-p .95, without a fixed seed. Models must support function tools for Agent 1. The selected Nemotron model uses `LLM_REASONING_BUDGET=128`; leave `LLM_REASONING_EFFORT` empty. This caps internal reasoning while preserving answer/tool output capacity. If switching back to NVIDIA Mistral Large 4, use `none` or `high` (not `low`/`medium`). Provider reasoning continuation stays private in memory and is excluded from returned messages, tool results, events and evidence. Calls are bounded to 90 seconds and 4,096 output tokens (`LLM_MAX_TOKENS`, constrained to 256–8,192); refusal, truncation and malformed specialist output fail closed. No model-call repair/retry occurs automatically.

For individual services, with a running compatible local chain:

```sh
npm run compile
npm run fixture
npm run facilitator
npm run server
npm run ui
# In another terminal:
npm run experiment
npm run verify
npm run check:artifacts
```

`npm run verify [-- evidence/<run-id>.json]` checks a completed **live LLM** run against its local receipt, token transfer, nonce event, balance deltas, and lifecycle journal. It rejects controlled test evidence. Verified evidence is written to `evidence/<run-id>-verified.json`. Dashboard export includes the currently retained public event window; the verifier reads durable journals.

## Protocol and payment behavior

The project-owned profile is `urn:local:a2a-x402:execute-before-settle:v1`. This intentionally differs from the previous settle-before-execute implementation. It uses the installed official A2A SDK's `SendMessage` with `configuration.returnImmediately: true`, followed by read-only `GetTask`. Only those methods are enabled. The active delegation tool owns polling, initially every 2 seconds with bounded backoff to 4 seconds and an overall 240-second deadline.

The first SendMessage returns actual HTTP 402 with `PAYMENT-REQUIRED`. Agent 1 validates exact terms against the discovered card and host budget, creates one EIP-3009 authorization, and retries the identical message/body with `PAYMENT-SIGNATURE`. Successful verification promptly acknowledges a server-generated Task ID. The server executes the specialist, validates its structured result, stages it privately, calls `/settle` once, independently checks the mined `Transfer` and `AuthorizationUsed` events, then completes the Task. Completed polls include `PAYMENT-RESPONSE` and the result artifact. Intermediate task artifacts and history contain no assessment.

Price is fixed at **2 TestUSD** (2,000,000 six-decimal units), paid to AgentCard on local chain 31337. TestUSD is local accounting only. The authorization lasts up to 600 seconds; admission requires 120 seconds remaining. The client signer and facilitator gas signer are fresh isolated keys under `runtime/`, restricted to mode 0600. Signatures remain in memory; durable state stores only fingerprints, public authorization summaries and a private staged result.

Task reads require the host-generated, request-bound `X-Task-Access` credential. This is an experiment-specific access mechanism, not a general A2A authentication standard. It is absent from model context, browser data and public journals. Unknown/mismatched credentials return 404. Repeated paid submissions with identical identity/proof reuse the same task; conflicting bodies/proofs and cross-request nonce reuse are rejected.

Execution failure, invalid output, or expiry before settlement never calls `/settle`. Settlement failure withholds the result. A lost acknowledgement, polling timeout, unknown settlement response, or restart is reported as **unresolved**. There is no `inspect_request_status`, automatic recovery, resubmission, new authorization, or restarted execution. A polling timeout does not cancel the server: a valid accepted task may still finish and settle; its client run remains unresolved. An issued EIP-3009 authorization remains cryptographically valid until used/expired even when this framework declines to submit it.

## Viewing the server's on-chain AgentCard

Open **Agent 2 · On-chain AgentCard** in the dashboard to view the deployed card, contract address, registry, block number, active flag and content hash. **Refresh card** reads it again from the local chain. The field guide explains its identity, advertised skills, protocol capabilities, payment terms and security metadata. The dashboard provides read-only access to the card.

## Verification

Stop the experiment services before running the integration suite, which uses ports 4021/4022 and a separate temporary Hardhat chain on 18545:

```sh
npm run compile
npm run typecheck
npm test
```

Tests use explicitly labeled controlled models with the real contracts, SDK transport, signatures, facilitator and receipt checks. They cover successful result incorporation, execution before settlement, private staging, authenticated read-only polling, duplicates/conflicts, cross-request nonce reuse, execution failure without nonce consumption, invalid proofs/output, expired admission, unresolved settlement/poll interruptions, restart without resumption, and stale-chain rejection. These tests do not establish cloud model quality or provider availability.

## Source map and provenance

- `apps/client/src/agent1.ts` — LLM coordinator loop; `tools.ts` — host-owned discovery/payment/polling tools.
- `packages/llm/src/` — cloud adapter and structured specialist execution.
- `apps/server/src/payment-gate.ts` — durable task lifecycle and private delivery gate; `service.ts` — official SDK transport integration.
- `scripts/facilitator.mjs` — local SDK verification/settlement and transaction idempotency.
- `contracts/AgentRegistry.sol`, `packages/shared/src/registry.ts` — chain directory and anchored discovery.
- `apps/dashboard/`, `packages/experiment/src/events.ts` — responsive dashboard, SSE observability and public journals.
- `proposal.md` — approved design; `IMPLEMENTATION.md` — implementation/validation record.

This root is an independent modified copy of authored code from `../Build`, including TestUSD, AgentCard, the facilitator and deployment/state utilities. Existing SPDX notices are retained. It has its own dependency installation, fixture, keys, runtime and evidence; it does not execute from or modify Build. Unused old client/statistics/dashboard/check code is archived under `reference/` and is excluded from TypeScript compilation and runtime.

Streaming, push, cancellation, multi-turn sessions, remote chains, arbitrary payees/prices, recovery and withdrawal workflows are outside this iteration. Public history is limited to 2,500 events in the dashboard; source journals retain events by process. Ordering is causal within each source; wall-clock ordering across processes is only a display aid.

Provider reference: [NVIDIA Nemotron Lightning inference API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer).
