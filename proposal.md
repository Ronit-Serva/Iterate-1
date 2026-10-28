# Proposal: two-agent task completion through the local A2A–x402 extension

Date: 2026-10-29  
Status: implementation proposal; no application changes made.  
Objective: [Objective.md](Objective.md). Implementation root: `../Build`.

## 1. Outcome and interpretation

Extend the working paid statistics prototype into a reproducible experiment in which Agent 1 receives an original task, discovers Agent 2 through an on-chain registry, delegates a necessary subtask through A2A/x402, verifies local-chain payment, and uses the returned result to produce its own final output.

The existing build already implements most of the transport and payment machinery. The principal additions are a registry lookup, an explicit Agent 1 task workflow, and evidence joining the original task, delegated request, confirmed payment, and composed output.

Scope decisions:

- Use deterministic software agents for this experiment. Objective.md does not require an LLM, autonomous planning, natural-language understanding, or external model credentials. Agent 1 will have an explicit task decomposition and completion policy; Agent 2 remains the statistics specialist.
- Interpret discovery as the specified one-way lookup: Agent 1 discovers Agent 2. Mutual discovery is unnecessary for the stated flow and success criteria.
- Add a small, explicit registry contract. The current AgentCard is a single card store at a known address; there is no separate registry. Although that could serve as a one-entry registry, a dedicated registry makes the objective's registry-address bootstrap unambiguous.
- Treat “local copy of x402” as the pinned packages installed in this project and the separately running local facilitator. There is already real x402 authorization and settlement, with no hosted payment service. Vendoring or independently rewriting the upstream SDK is not required by the objective.
- Retain settlement before service execution. The objective requires both completion and payment, but does not require delivery before payment. Changing this ordering would weaken the existing payment gate without helping the experiment.

## 2. What the current extension actually does

This assessment combines the referenced Codex task with direct inspection of the current source. Source is authoritative where older progress notes describe superseded behavior.

| Layer | Current implementation | Reuse for this iteration |
| --- | --- | --- |
| Local chain | Hardhat, chain ID 31337, loopback RPC | Keep |
| Card and identity | `contracts/AgentCard.sol` stores A2A JSON, owner and active flag; receives payments; owner can update/withdraw | Keep as Agent 2's card and recipient |
| Token | `contracts/TestUSD.sol`: 6-decimal ERC-20, restricted minting, EIP-712/EIP-3009 authorization | Keep |
| Card reader | `packages/shared/src/card.ts` reads `config.agentCard` directly and validates statistics/payment terms | Add registry resolution ahead of this reader |
| Agent 1 today | `apps/client/src/run.ts` sends numbers and returns Agent 2's response, receipt and balances | Add original-task handling and result composition |
| Agent 2 | `apps/server/src/service.ts` uses the official A2A SDK executor to calculate count, sum, min, max and mean | Keep the real delegated computation |
| Payment transport | `apps/client/src/payment.ts` checks the 402 challenge against card terms/budget, signs once, retries with `PAYMENT-SIGNATURE` | Keep |
| Payment enforcement | `apps/server/src/payment-gate.ts` requires extension activation, binds request/body/payment, settles before invoking the SDK handler | Keep |
| Facilitator | `scripts/facilitator.mjs`: separate local `/supported`, `/verify`, `/settle` service using x402 SDK and its own gas signer | Keep |
| Recovery | Deployment-scoped server/facilitator records, nonce deduplication, receipt/event reconciliation | Preserve |
| Dashboard | Local process controls, manual checkpoints, SSE events, payment evidence and transient signed-payload view | Extend to show the original task and Agent 1's completion |

The wire profile is pinned in this build: A2A SDK 1.3.0 / protocol 1.0, JSON-RPC `SendMessage`, `A2A-Extensions`, and x402 core/evm 2.28.0 / v2 `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`. The extension URI is the project's placeholder `https://example.org/a2a/x402`; this is a local integration profile, not a claim of a published standard extension.

The client currently pays 2 TestUSD to AgentCard; the facilitator supplies native ETH gas. The service reads neither private signer. Successful token transfer, rather than signing or verification alone, unlocks computation.

## 3. Concrete experiment

Original task supplied to Agent 1:

> Assess whether the average of [2, 4, 6] meets a target of 5. Obtain the statistics from Agent 2, then produce an assessment that includes the average, the target, and the shortfall or surplus.

Proposed typed input:

```json
{
  "kind": "assess-average",
  "numbers": [2, 4, 6],
  "targetMean": 5
}
```

Agent 1 validates the task and assigns an `originalTaskId`. It resolves the configured Agent 2 key from the registry, reads the resolved AgentCard, checks the statistics capability and payment terms, and sends the existing `{numbers}` data part with a distinct delegated `messageId`. The task envelope need not become an A2A asynchronous Task: the existing standalone blocking `SendMessage` profile is sufficient.

Agent 2 computes `{count:3,sum:12,min:2,max:6,mean:4}` after payment confirmation. Agent 1 validates the returned A2A result and uses its `mean` to calculate:

```json
{
  "kind": "average-assessment",
  "observedMean": 4,
  "targetMean": 5,
  "meetsTarget": false,
  "difference": -1,
  "summary": "The average is 4, which is 1 below the target of 5."
}
```

This final assessment demonstrates incorporation of the delegated result. Agent 1 must derive it from Agent 2's returned statistics; it must not independently calculate the input mean and substitute that for delegation. Validate finite numeric fields, expected count, and internal consistency of the returned statistics before composition. This is response validation, not proof that an arbitrary remote agent is truthful.

## 4. Required changes and new components

### A. Add an explicit on-chain registry

Add `contracts/AgentRegistry.sol`, using the existing OpenZeppelin ownership pattern:

- `mapping(bytes32 => address)` from a stable configured agent key to an AgentCard address.
- Owner-only register/update/remove operations and events recording the key and card address.
- Reject zero-address registration and addresses without deployed code; removal is explicit.
- No payment custody or token transfer in the registry. AgentCard remains the payee and card-active status remains authoritative.

Add `packages/shared/src/registry.ts` to resolve Agent 2 from the configured registry address and key. Read registry and card at a common block for discovery consistency, validate the card, and return the registry address, key, resolved card address and discovery block/hash as provenance.

Modify `packages/shared/src/local.ts` and `scripts/m1-local.mjs` to deploy/register Agent 2 and include `registry`, `agent2Id`, and the registry code hash in public deployment metadata. Seed the deployment anchor after registration and fixture setup. Extend stale-deployment checks to the registry.

The client must obtain the selected card address from the registry, rather than silently falling back to `config.agentCard`. The existing manifest card address can remain the deployment fixture's expected recipient and a cross-check. A registry entry pointing to another address should fail clearly under this single-agent fixture; supporting arbitrary replacement agents is a later capability.

Update `card.ts` to accept the explicitly resolved card address when reading and validating the payee. Preserve the current exact token/network/price checks. The service and facilitator can retain their fixture-bound recipient configuration.

### B. Turn the client into Agent 1's workflow

Add `packages/shared/src/experiment.ts` for typed original tasks, delegated-result validation, and final assessment construction. Keep SDK result parsing in a clear adapter using the installed SDK's response representation.

Add `apps/client/src/agent1.ts` to own this sequence:

1. Validate the original task and allocate its ID.
2. Resolve/read Agent 2 from the registry.
3. Allocate a delegated request ID and record the relationship to the original task.
4. Execute one paid A2A call through the existing transport.
5. Validate the successful A2A response and confirmed payment evidence.
6. Compose and return the final assessment using the delegated statistics.

Refactor `run.ts` so its paid-call helper accepts a discovered, validated card and resolved deployment context. Retain a compatible `runPaid(numbers, requestId)` wrapper for existing CLI/regression callers. Add an `experiment` CLI entry and npm script accepting the typed original-task JSON; preserve the existing direct statistics demo.

Keep correlation in the application record rather than introducing A2A `taskId` or `contextId`: the current payment gate deliberately rejects those fields. The delegated `messageId` remains the durable server/payment identity.

### C. Keep Agent 2 and payment enforcement focused

Agent 2 already provides the required specialist task; no new service, model backend, or extra agent process is needed. Agent 1 is the client process with the new workflow; Agent 2 is the existing server process.

Preserve challenge validation, budget enforcement, extension activation, settle-before-execute behavior, and request/proof association. Add structured correlation events around discovery, delegation, result receipt, and final composition. Never log the complete signed proof as persistent evidence.

Do not add registry policy to the facilitator. It should continue verifying and settling the configured payment terms. EIP-3009 authorizes a token transfer and does not sign the original task or delegated body; the experiment's correlation record must describe that association accurately.

### D. Produce one complete evidence artifact

Add `packages/shared/src/experiment-evidence.ts` and a verifier/check script. Write a sanitized `evidence/iteration-1-result.json` containing:

- Experiment ID, original task ID and typed input.
- Registry address, agent key, resolved card address, discovery block/hash and deployment anchor.
- Delegated request ID, delegated input and returned statistics.
- Chain ID, token, payer, payee, amount in base units and payment transaction hash.
- Independently queried successful receipt and decoded `AuthorizationUsed` / matching `Transfer` evidence.
- Final Agent 1 assessment and completion status.

Use the delegated request ID to join the server's durable record and recorded receipt to the artifact. Check token address, payer, AgentCard payee and exact amount, rather than accepting any successful transaction. Record observed ordering so settlement precedes Agent 2 execution and Agent 1 composition follows the returned result. Application events establish workflow ordering; chain receipts establish payment.

No private keys, signatures or complete authorizations go into the artifact. On failure, record the actual stage and any known transaction hash; a paid-but-undelivered result must not be presented as experiment success. Pending/unknown payment cannot produce a successful final assessment.

`evidence/` is currently ignored by Git. Runtime generation and a documented location suffice for this local experiment; selectively tracking sanitized evidence would be a separate repository decision.

### E. Extend the existing walkthrough

Modify `apps/dashboard/src/index.ts`, `apps/dashboard/public/app.js`, `index.html`, and shared walkthrough events to accept the target alongside numbers, show the original task, registry lookup, delegated result and final assessment, and retain payment evidence.

Keep the dashboard's existing paid-retry transient view and signer isolation. Add the target/task kind and original/delegated IDs to its bounded public run summary as needed. Do not persist the signed payload to support the new workflow.

Keep existing controls and direct CLI compatibility. For the new experiment path, add an explicit final composition stage after Agent 2's response. Existing 60-second checkpoint limits still apply; a timed-out or canceled workflow must not silently start another payment.

## 5. Delivery sequence and verification gates

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 1 | Registry, manifest, resolver and fixture changes | Authorized registration resolves correctly; missing/removed entry, inactive card, unauthorized update and stale-chain registry are rejected |
| 2 | Agent 1 task workflow and CLI | Real discovery and paid delegation produce the expected assessment for [2,4,6], target 5 |
| 3 | Joined evidence and independent receipt verification | Original/delegated IDs, matching token transfer and final output are present in one artifact |
| 4 | Dashboard experiment flow | User supplies original task, observes registry discovery/delegation/payment and receives Agent 1's assessment |
| 5 | Reproduction and documentation | Fresh local run succeeds; existing paid flow and recovery checks remain valid |

Add `scripts/iteration1-check.ts` and a proposed `npm run iteration1:check`. Make the experiment part of `scripts/reproduce.mjs` after existing M0–M7 gates, with a known fixture balance or explicitly measured before/after balances. Extend existing scripts only where the registry/schema changes affect their assumptions; `scripts/compile.mjs` already discovers Solidity files automatically.

Meaningful new checks:

- The happy path charges exactly once and produces mean 4, meetsTarget false, difference -1.
- The final output changes when the returned statistics change; malformed or failed delegated responses cannot yield success. A focused response-adapter test can establish this dependency, alongside the real integration path.
- Invalid original input fails before signing/payment; unavailable registry/card/service fails with a clear stage.
- Reusing a payment for a conflicting delegated request is rejected; same-request retry behavior remains consistent with the existing gate.
- Verification failure or pending settlement never runs Agent 2; payment confirmation followed by service failure remains paid-undelivered and produces no successful assessment.
- Registry or manifest tampering/stale chain state fails before delegation.
- Artifact transaction tampering is detected by independent receipt/event checks.
- Public evidence and run histories contain no signer secrets or signed payloads.

Run compilation, typechecking, the new experiment integration check, and the existing reproduction/recovery suite. Update `ui-check.mjs` for the additional input/stages and run it against the revised dashboard. Perform rendered browser verification of the new controls and evidence display. Existing recorded checks are historical evidence: later privacy/theme and recent fixes were not all reverified, so their prior pass status is not proof of this iteration.

## 6. Boundaries and completion criteria

No additional LLM service, browser wallet, hosted facilitator, public testnet, new payment scheme, escrow/refund contract, marketplace, or multi-agent planner is necessary. Existing pinned dependencies should cover the proposed additions. Public-chain operation and generalized agent replacement would require further work beyond this objective.

Preserve the current limitation that an interrupted client cannot automatically replay a discarded signed proof. Do not promise exactly-once external side effects or atomic payment-and-delivery. The final workflow is successful only after both confirmed payment and a validated delegated result incorporated into Agent 1's final assessment.

The iteration is complete when a fresh local experiment demonstrably follows all five steps in Objective.md and its evidence artifact records the delegated request ID, independently verified payment transaction hash, and Agent 1's final output. This proposal is based on source inspection; implementation and new execution checks remain to be done.

## 7. Source map

- [Objective](Objective.md)
- [Current build instructions](../Build/README.md)
- [Protocol and evolution decisions](../Build/DECISIONS.md), especially D004, D007–D011
- [Card validation and payment terms](../Build/packages/shared/src/card.ts)
- [Current client workflow](../Build/apps/client/src/run.ts) and [payment transport](../Build/apps/client/src/payment.ts)
- [A2A service](../Build/apps/server/src/service.ts) and [payment gate](../Build/apps/server/src/payment-gate.ts)
- [Local facilitator](../Build/scripts/facilitator.mjs)
- [AgentCard contract](../Build/contracts/AgentCard.sol) and [TestUSD](../Build/contracts/TestUSD.sol)
- [Deployment validation](../Build/packages/shared/src/local.ts), [fixture setup](../Build/scripts/m1-local.mjs), and [durable state](../Build/packages/shared/src/store.ts)
- [Dashboard backend](../Build/apps/dashboard/src/index.ts), [integration check](../Build/scripts/ui-check.mjs), and [reproduction runner](../Build/scripts/reproduce.mjs)
- Referenced Codex task `01a172ba-75c3-73d1-9940-43afd8e83ee5`, read through `read_thread`; recent messages establish context for the existing dashboard and client fixes.
