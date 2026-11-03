# Iteration 1 implementation record

Implementation root: `/home/ronit/Blockchain-Focus/Iterate#1`.

Current status: recovered and live-verified using NVIDIA Nemotron 3.5 Lightning for both agents. See the final follow-up below; earlier model failures and successes are historical records.

The approved architecture is implemented as a project-owned modified copy of Build. Build remains unchanged. Installed dependencies are pinned in this root. Obsolete baseline paths are archived in `reference/`; they are not active entrypoints.

| Requirement | Implementation |
| --- | --- |
| Independent LLM coordinator and specialist | `apps/client/src/agent1.ts`, `packages/llm/src/runtime.ts`, shared cloud adapter |
| On-chain directory → active AgentCard | `AgentRegistry.sol`, anchored manifest and `registry.ts` |
| Actual 402, verify, isolated signing, identical retry | Five host-policy tools in `apps/client/src/tools.ts` |
| Execution before settlement | Durable task gate with private staging and one settlement submission |
| Release only on confirmed payment | Independently decoded token Transfer and AuthorizationUsed events, then completed task artifact |
| Official A2A task polling | SDK SendMessage acknowledgement and bounded SDK GetTask loop |
| No status recovery tool | No inspect_request_status or recovery endpoint; interruption remains unresolved |
| No duplicate execution/payment | Bound body/proof/credential hashes, message index and nonce index |
| Observable dashboard | Agent panels, actual communication timeline, payment gate, inspector, archive and evidence export |
| Evidence | Run/task/message IDs, card provenance, models, nonce summary, transaction, balances, assessment and final output; independent verifier |

The local profile explicitly advertises verify-execute-settle-release and task-polling semantics. Price is 2 TestUSD and authorization lifetime is 600 seconds, with at least 120 seconds required at admission. Unsupported A2A methods, streaming, push and multi-turn requests are rejected. Normal task polls never invoke payment handling or model execution.

Validation completed so far:

- Local compilation: 28 contracts; upstream OpenZeppelin future-keyword warnings only.
- Strict TypeScript checking passed.
- Eleven lifecycle and provider-adapter checks passed against a temporary blockchain, real x402 signatures/facilitator, real A2A SDK transport and explicitly controlled model responses. The adapter check verifies actual request formatting, sampling, tool calls, truncation rejection and omission of hidden reasoning from journals.
- `npm start` successfully created a fresh fixture and started the four local services.
- Dashboard static assets, DOM ID references, CSP, session guard, SSE replay, and service health checks passed.
- Visual browser QA is unavailable: computer-use inventory exposes no browsers or native apps in this session. Responsive styles are implemented, but rendered desktop/mobile appearance is not yet verified.

Live NVIDIA validation is recorded separately from controlled tests. **The final Mistral live run passed independent verification.** The first live run, `cff47531-a9c9-41a4-a3d4-064680f66f56`, timed out on its first model call after 90 seconds, before discovery, authorization creation or payment. No successful live evidence or settlement is claimed for that run. A minimal 20-second inference probe, a 60-second low-reasoning probe, and a 20-second streaming first-byte probe also timed out without a response. A credential-free HEAD request returned HTTP 405 promptly, establishing endpoint connectivity but not inference readiness. This was a failed historical DeepSeek attempt; the user subsequently selected Mistral (see final validation below).

Operations and limitations are documented in README.md. Private staging exists only in restricted runtime files; public task projections, SSE, snapshots and exported events omit it. Client signatures stay in memory. On restart, incomplete server tasks and orphaned client runs become unresolved and are never resumed. If client polling is interrupted, an accepted server task may still finish and settle; its client run remains unresolved. This is deliberate and does not introduce the removed recovery function.

The selected cloud model was changed by the user to `mistralai/mistral-large-4-1t-a52b`. Its first live run (`1952114e-8a8d-4082-bbbe-996ffd31cdfe`) completed discovery, all payment tools, authorization verification and Task acknowledgement, but specialist inference failed. An on-chain failure check confirmed no settlement submission, unchanged balances (100 client / 0 card TestUSD) and unused nonce; evidence is in `evidence/1952114e-8a8d-4082-bbbe-996ffd31cdfe-failure-verified.json`. The model configuration was then tuned to low reasoning effort and a bounded 4,096-token completion limit for a separate run. Safe completion diagnostics now record finish reason and usage without model reasoning or unreleased content.

## Final live validation

The distinct Mistral run `2d94c877-714c-448c-b6eb-e4916a415954` completed with both real cloud LLMs. A2A Task ID: `fa3441d5-ca10-4596-8732-fcaf1b2dee8c`.

Payment transaction: `0x36f8fd86e0d2bb790b644ea68447e986a05c9add2702ed67acd62735f1474c06`.

`npm run verify` passed against the live chain and 54 correlated events. It established on-chain card discovery, one authorization and paid retry, normal GetTask polling, specialist output validation/private staging before settlement, confirmed Transfer and AuthorizationUsed events before delivery, and an Agent 1 final model response using the delivered assessment. Balances changed from 100/0 to 98/2 TestUSD (client/card). The final recommendation selects the managed dashboard platform and explicitly incorporates specialist findings about the six-week deadline, maintenance load, vendor dependence and a possible later migration.

Artifacts:

- `evidence/iteration-1-result.json` — complete public run evidence and verification checks.
- `evidence/2d94c877-714c-448c-b6eb-e4916a415954-verified.json` — verified immutable-by-convention run export.
- `evidence/1952114e-8a8d-4082-bbbe-996ffd31cdfe-failure-verified.json` — separate real-model execution failure with unused nonce/no payment.

Final checks: 11 automated checks passed; strict TypeScript and dashboard JavaScript syntax passed; local compilation passed; dashboard API/static/SSE/session checks passed; key permissions and secret-leak scan passed. No browser surface is available, so rendered desktop/mobile visual QA and interactive browser walkthrough remain unverified. The running dashboard contains the actual live run and historical failures. No mocked run has been presented as live success.

## Model-call failure diagnosis — 2026-10-30

The two reported runs (`9c9d3811-e4fa-446f-ae4d-644ec7270f81` and `5a35d667-c948-424e-b403-77b3d72e8360`) both stopped on Agent 1's first model request after 90,002 ms, before discovery, signing, Task creation or payment. These were model inference failures, not A2A polling or settlement failures.

A concrete compatibility defect was found: `.env` and the example selected `LLM_REASONING_EFFORT=low`, while the current NVIDIA Mistral Large 4 recipe documents only `none` and `high`. The adapter's old generic validator rejected the valid `none` value. The local configuration and example now use `none`; the NVIDIA/Mistral-specific validator fails immediately on `low`/`medium` and defaults to `none` when unset. `high` mode now preserves the required reasoning continuation privately in a per-model WeakMap, without adding it to public messages, tool results, events, or evidence. Reference: https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer

There is also a current external inference problem: HEAD returns 405, an unauthenticated POST returns 401, and model discovery returns 200 listing the selected model, all promptly. The original authenticated inference request times out through both native fetch and curl. Corrected minimal requests with `reasoning_effort=none` and with the reasoning field omitted also stalled; a valid minimal `none` request received no response within 120 seconds. One actual-adapter probe returned HTTP 400 after approximately 89 seconds, but its original generic error handling discarded the provider body, so its specific validation reason is not established. Model-list success establishes endpoint reachability/listing, not inference readiness or account entitlement. The configuration defect is fixed, but a new successful cloud inference/live run cannot presently be claimed. The previous day's verified run remains historical evidence only.

Diagnostics now distinguish timeouts before headers, connection failures, rejected credentials, rate limits, API-credit errors and request-parameter errors. HTTP failures record a safe provider request ID when available, without recording provider bodies. The 90-second production timeout and no-automatic-retry policy remain in place. No payment was created by these diagnostic probes.

Validation after the fix: strict TypeScript passed; all 13 regression checks passed, including new reasoning-mode validation, private reasoning continuation, and sanitized HTTP-422 diagnostics; dashboard/static/SSE/session checks and secret-leak scan passed. The local test stack was restarted with the corrected configuration. Failed run records were retained and were not resumed.

## Follow-up recovery — NVIDIA model replacement

After the reported timeout for run `0164b039-d53c-4c24-9efa-3a102b8a636a`, the user authorized switching both agents to a tested working NVIDIA model. The same endpoint and credential successfully served `nvidia/nemotron-3.5-lightning-30b-a3b`, including a real function call in 1.4 seconds and structured JSON in 1.6 seconds. This isolates the observed timeout to the configured Mistral inference service/request path, rather than the local chain, A2A transport, or all NVIDIA inference access. No specific internal cause inside NVIDIA's Mistral deployment is claimed.

Both agents are now configured for Nemotron Lightning. Its documented `reasoning_budget` is capped at 128 tokens, rather than sending Mistral's `reasoning_effort`. The completion budget stays 4,096 tokens and the production timeout remains 90 seconds. The adapter validates these model-specific settings and preserves reasoning only as private provider continuation state. There is no automatic model failover, payment resubmission or retry of old failed runs.

A fresh real-LLM experiment `c5d54f90-c9fc-4df7-a2d3-d304811633a6` completed and passed `npm run verify` against 54 correlated events. Task ID: `a8fd0c74-79e8-4263-ad83-387dee070e31`. Transaction: `0xa05ba82fbcaaeee76476dc1ba4e9380668a98f813ad6d94dde1a2f2fea9d5bf7`. Balances changed from 100/0 to 98/2 TestUSD, with execution and private staging before settlement, confirmed payment before delivery, normal GetTask polling, and final synthesis by Agent 1. Model calls took 0.6–7.3 seconds. Evidence: `evidence/c5d54f90-c9fc-4df7-a2d3-d304811633a6-verified.json` and `evidence/iteration-1-result.json`.

All 14 regression checks, strict TypeScript, dashboard service/static/SSE/session checks, and the secret-leak scan passed. The dashboard is running at http://127.0.0.1:4030 with the replacement model loaded.

Provider budget reference: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer
