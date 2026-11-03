# Proposal: LLM agents using a modified local A2A–x402 extension

Date: 2026-10-29
Status: approved design; implementation is now in this root. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for validation and remaining limitations.
Project and implementation root: **`/home/ronit/Blockchain-Focus/Iterate#1`**.
Requirements: [Objective.md](Objective.md), amended by the user's instructions that both agents use LLMs and that execution precedes settlement, A2A task polling is used, and interrupted requests are reported as unresolved.

## 1. Required outcome

Build a working local experiment with two LLM-based agents. Agent 1 receives an original task, uses a tool to discover Agent 2 through a local blockchain directory, delegates a subtask, handles an HTTP 402 challenge through payment tools, and uses the paid result to finish the original task. Agent 2 verifies the authorization, executes the request with its LLM, settles only after successful execution, and releases the result only after confirmed settlement.

The required server ordering is:

**Validate request → challenge → verify payment authorization → execute request → validate and stage result → settle payment → confirm transaction → release result.**

If execution fails or cannot produce an acceptable result, the server must never submit that request's payment authorization for settlement. This deliberately changes the earlier implementation, which verifies and settles before execution.

Both agents use model-generated decisions/output; a fixed statistics function and a deterministic assessment wrapper do not meet this revised scope. Deterministic code still owns protocol validation, signing, budgets, persistence, and payment gates.

## 2. Existing system and what changes

The previous implementation is in `../Build`. It is the source baseline, not the implementation root for this iteration. Its current components include:

| Component in the baseline | Current behavior | Iteration treatment |
| --- | --- | --- |
| `contracts/AgentCard.sol` | Stores A2A JSON, owner and active flag; receives token payments | Reuse with revised LLM capability description |
| `contracts/TestUSD.sol` | Six-decimal local ERC-20 with EIP-712/EIP-3009 authorization | Reuse |
| `packages/shared/src/card.ts` | Reads a known card address; validates statistics skill and fixed payment terms | Resolve through directory; validate Agent 2's new capability |
| `apps/client/src/run.ts` | Sends numbers and returns statistics | Replace experiment entry with Agent 1's LLM/tool loop |
| `apps/client/src/payment.ts` | Validates 402 terms, signs, retries | Refactor into tools plus a request-bound payment session |
| `apps/server/src/service.ts` | Executes deterministic statistics through official A2A SDK | Replace experiment executor with Agent 2's LLM runtime |
| `apps/server/src/payment-gate.ts` | Verifies and settles before SDK execution | Substantially modify for execute-before-settle and result withholding |
| `scripts/facilitator.mjs` | Separate local x402 verification and settlement endpoints | Reuse independent endpoints and idempotency; call settlement later |
| Shared durable state | Request/body/proof association, deployment anchors, cached results | Extend with execution and staged-result states |
| Dashboard | Process controls, manual checkpoints and payment evidence | Build a redesigned experiment dashboard showing both agents, live communication, A2A tasks and the modified payment lifecycle |

The pinned baseline uses A2A SDK 1.3.0/protocol 1.0 and x402 core/evm 2.28.0/v2. It sends `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`, with explicit `A2A-Extensions` activation. Preserve these wire mechanics and the existing TestUSD/local-chain profile unless implementation testing reveals a necessary adjustment.

The main change belongs in the framework adapter and its execution lifecycle, not in EIP-3009 or token contracts. The facilitator already exposes separate `/verify` and `/settle` operations. Create a project-owned modified copy of the earlier integration; do not edit installed dependency files. Document the new behavior explicitly in the extension description/parameters while retaining an unambiguous extension identifier for the local profile.

## 3. Make Iterate#1 an independent project

Copy the relevant authored source, contracts, scripts, package manifest/lockfile and configuration from `../Build` into this root. Preserve applicable license notices and record baseline provenance. Keep the earlier project unchanged.

Do not copy `node_modules`, signer keys, `.git`, deployment manifests, chain state, runtime records, generated artifacts, or old evidence as this iteration's execution evidence. Install dependencies in this root, compile locally, create fresh keys, deploy a fresh fixture, and generate this project's `deployments/local.json` and deployment-scoped runtime records.

All commands, imports, process working directories, evidence paths and documentation must resolve from Iterate#1. No runtime dependency on a working directory or signer file in `../Build` is acceptable. Add environment configuration documentation for the LLM runtime. Provider selected during implementation: NVIDIA cloud OpenAI-compatible Chat Completions at `https://integrate.api.nvidia.com/v1`, using `nvidia/nemotron-3.5-lightning-30b-a3b` for both agents (user-authorized replacement after the Mistral endpoint stalled) and a server-side `NVIDIA_API_KEY`. The adapter uses native fetch, so no additional model SDK dependency is needed.

## 4. Blockchain directory and Agent 1's tools

Add a minimal `contracts/AgentRegistry.sol`: an owner-managed mapping from configured agent keys to AgentCard contract addresses, with registration/update/removal events. Reject invalid registration targets. Keep token custody in AgentCard and enforce its active flag. This is a small directory, not a marketplace or ranking system.

Add `packages/shared/src/registry.ts` and extend fixture/manifest/deployment validation with the directory address, Agent 2 key and directory code hash. Anchor state after deployment, registration and seeding. Agent 1 receives the directory bootstrap and lookup key, and obtains the card address and endpoint through a real chain read. Read directory/card consistently at a known block and record provenance. Do not silently replace failed discovery with a hardcoded server URL.

Agent 1's LLM runtime receives a narrow tool interface, implemented in host code:

| Tool | Host-side operation and validation |
| --- | --- |
| `lookup_agent_card` | Read directory and card; validate active status, interface, capability and payment terms; return sanitized card and discovery reference |
| `request_agent` | Send an A2A request to the discovered endpoint using a stable delegated message ID; return a structured response or HTTP 402 challenge reference |
| `verify_payment_challenge` | Decode the actual `PAYMENT-REQUIRED` header; check version, network, asset, amount, payee, endpoint and remaining budget against trusted configuration/card |
| `sign_payment` | Load Agent 1's isolated signer and create one EIP-3009 authorization for validated terms; return an opaque session handle and public summary |
| `retry_with_payment` | Retry the identical nonblocking `SendMessage` with its associated `PAYMENT-SIGNATURE`; receive a Task and use the host-managed `GetTask` polling loop to await completion or report failure/unresolved |

The LLM decides to invoke the discovery, delegation and payment tools in context. Host code enforces their allowed order and associations; model text cannot override endpoint restrictions, budgets or settlement rules. A combined higher-level tool may wrap these primitives later, but the experiment must retain evidence of the real lookup, 402, signing and paid retry.

Private keys and raw signed authorizations are never passed to either LLM or included in its prompts/tool transcript. Keep the authorization in the trusted payment session; the existing optional local transient payload display can remain separate. Treat AgentCards and remote/model responses as data rather than instructions that can alter tool policy.

### A2A task polling

Use A2A JSON-RPC over HTTP with `SendMessage` followed by repeated `GetTask` calls. The installed SDK exposes `configuration.returnImmediately: true` and `client.getTask({tenant, id, historyLength})`. The initial message and its paid retry use the same message ID, body and nonblocking configuration. The server creates a task after successful payment verification and returns its server-generated task ID promptly, while execution and settlement continue in the background. The acknowledgement contains no specialist result and does not claim payment has settled.

Agent 1's host runtime polls that task using the SDK, initially every two seconds with bounded backoff and an overall deadline. Normal polling belongs to the active delegation tool call and does not require another LLM call on every tick. There is no separate custom status-inspection tool or payment-recovery endpoint in this iteration. A2A task polling is the normal interaction between the agents.

Keep the A2A task ID, delegated message ID and original task ID distinct and record their mapping. Polls are read-only: they do not invoke the model, sign a proof, submit a payment, or create another task. Apply the payment challenge to the initial `SendMessage`; do not charge or run the client's 402 payment-signing handler on `GetTask`.

Protect task reads using a host-held, request-bound credential established by the client before submission and bound by the server to the accepted task. Return sanitized task status before settlement. Exclude staged model output from artifacts, task history, status messages and metadata until payment confirms. After confirmation, publish the result artifact and mark the task completed. Return `PAYMENT-RESPONSE` on the completed `GetTask` response, including subsequent reads of that completed task; this is part of the project's x402/A2A adapter profile and must be documented. The client must capture that response header on task polls and independently verify the receipt.

If submission acknowledgement is lost, polling fails, the deadline expires, a process restarts, or an A2A interrupted state requires further input/authentication, stop the client workflow and report **unresolved** with known IDs/hash. Do not automatically resubmit `SendMessage`, resume a lost session, rerun execution or authorize another payment. A server task may continue after the client stops; unresolved does not imply failure, cancellation or absence of payment. Definitive task failures observed during normal polling are reported as failures.

This uses the installed A2A 1.0 profile, whose SDK declarations were checked locally. See the official [A2A task interaction specification](https://a2a-protocol.org/v1.0.1/specification/) for the nonblocking submission and Get Task polling pattern; implementation must retain the pinned SDK's actual wire serialization.

## 5. Both LLM agents and the experiment task

Add a shared provider adapter and bounded model/tool loop, with separate Agent 1/Agent 2 system prompts, model configuration, timeouts, token limits and explicit failure states. Both runtimes must invoke an actual LLM in the live experiment. Model credentials remain in server-side environment configuration and are excluded from evidence and browser responses. Local payment does not imply local model inference; hosted or local inference is a configuration choice to document.

Suggested initial task for Agent 1:

> Write a recommendation for a small team choosing between two proposed approaches. Ask the specialist agent to evaluate their risks and tradeoffs, then combine its assessment with the team's priorities to make your final recommendation.

Supply the two approaches, priorities and constraints as task input so the experiment does not need web research. Agent 1 uses the discovered specialist capability to formulate a delegated request. Agent 2 uses its LLM to produce a structured assessment containing a summary, tradeoffs, risks and limitations. Agent 1 receives that assessment only after settlement and uses it in its final model-generated recommendation.

Define bounded request/result schemas and validate Agent 2's structured output before declaring execution successful. Timeouts, provider exceptions, refusals, malformed output and explicit inability to perform the task count as execution failure and do not trigger settlement. A bounded repair attempt can remain within the same execution attempt; it cannot silently create another paid request. Schema checks establish acceptable completion for this experiment, not universal correctness of LLM answers.

Evidence must show Agent 1 consumed Agent 2's result in its final model call, and retain the returned final output. Exact prose is not an acceptance oracle: model behavior is nondeterministic and identical inputs may yield different answers.

## 6. Modify the server framework lifecycle

Restructure `payment-gate.ts` and `service.ts` around an internal execution result instead of settling before calling the current SDK handler. Proposed responsibilities:

1. Validate the request, extension activation, identity, body hash and payment association before execution.
2. For an unpaid request, return the actual 402 challenge without invoking Agent 2's LLM.
3. For a signed retry, call facilitator `/verify` and reject invalid proofs without invoking the model. Verification must not consume the nonce or transfer tokens.
4. Bind the verified authorization and polling credential to the delegated request, create/persist an A2A Task, and return its ID promptly. Schedule one background execution attempt; the HTTP request ending must not terminate that attempt.
5. Run Agent 2, validate success, and durably stage its result before any settlement submission.
6. On execution failure, record `execution-failed` and mark the A2A task failed; do not call `/settle`. Subsequent polls return a sanitized failure without a successful payment receipt.
7. On execution success, recheck authorization validity and call `/settle` for that request's verified proof.
8. Independently confirm the transaction/expected token events. Only then publish the staged result as an A2A task artifact, mark the task completed, and include `PAYMENT-RESPONSE` on completed task reads.

Do not let the SDK executor publish model output directly to the HTTP response/event bus before settlement. Implement an internal execution/staging layer and publish the A2A result after confirmation. Disable streaming and push delivery for the experiment; buffering only `res.json` is insufficient if other writes can leak output. Do not depend on a late response interceptor to enforce payment.

Expose the changed semantics in card metadata, documentation and dashboard labels. The original settle-before-execute execution-count guard must change: execution now requires a verified, request-bound authorization, whereas delivery requires confirmed settlement. These are separate invariants.

Replace the baseline `InMemoryTaskStore` with a durable task store linked to request/payment records. Permit `GetTask` in routing and implement nonblocking submission instead of rejecting `returnImmediately`. Keep the experiment restricted to one submitted subtask per payment; arbitrary follow-up messages on a task remain outside scope. Release submission locks after task creation so polling can proceed during model execution; use per-task execution/payment locks to prevent duplicate workers.

Map accepted/queued work to A2A `TASK_STATE_SUBMITTED`, execution and settlement to `TASK_STATE_WORKING`, confirmed payable completion to `TASK_STATE_COMPLETED`, and definitive execution or settlement failure to `TASK_STATE_FAILED`. Payment phases remain internal/extension metadata; do not invent additional A2A task states. Report unknown/interrupted outcomes to Agent 1 as unresolved without claiming completion. Keep staged output private even though computation has finished.

Proposed durable internal states:

`verified → executing → execution-succeeded → settling → settlement-pending → settled → delivered`

Terminal/exception branches include `execution-failed`, `execution-unknown`, and `settlement-failed`. A result may be staged and unpaid; it must never be returned as a successful delegated result in that state. Store request ID, A2A task ID/context ID, polling credential hash, body hash, payment fingerprint, execution attempt ID, result/status and known transaction hash under the deployment namespace.

## 7. Failure, expiration and retry behavior

| Condition | Required behavior |
| --- | --- |
| Invalid authorization or challenge | Reject before LLM execution; no settlement |
| LLM execution fails | Record failure; never submit that authorization for settlement; no token transfer by this framework |
| Execution succeeds but settlement fails | Retain staged result; withhold result; report payment failure without claiming delivery |
| Settlement pending/unknown | Withhold result while the active server worker checks its existing transaction; client polls within its deadline, then reports unresolved; never submit another payment automatically |
| Poll response or task acknowledgement lost | Stop the interrupted client workflow and report unresolved with known IDs/hash; do not resubmit, pay again or automatically resume |
| Process crash after staged-result persistence | Preserve records and private staged result for evidence; report the interrupted request as unresolved; automatic recovery/resumption is deferred |
| Crash during model execution before result persistence | Mark execution unknown; do not automatically rerun a nondeterministic request or charge without a staged successful result |
| Duplicate concurrent paid requests | Serialize by request/payment identity; perform at most one execution attempt in the running process and one token settlement |
| Same request ID with a different body/proof | Reject conflict unless using a separately designed, explicit replacement-authorization transition |

Payment authorization lifetime must accommodate bounded model execution and any manual pauses. The previous 300-second profile and fixed walkthrough timeouts need review together across card requirements, client validation and facilitator checks. Start execution only with sufficient validity remaining, and recheck before settlement. Verification reserves no funds: the payer can still spend its balance or cancel an authorization during execution.

If the authorization expires after successful execution, keep the result withheld and report that payment could not complete. For the first iteration, do not automatically request a new signature or rerun the model. A later explicit replacement-authorization flow would need conflict rules linking the new proof to the same staged result.

Keep raw proofs in memory only, as in the current privacy design. The background server worker retains its accepted proof only for the bounded active task, until settlement or terminal failure. A crash may lose it; mark the affected request unresolved and do not automatically resume it. Preserve durable records for evidence and duplicate prevention, without introducing persistent proof storage. The polling credential grants access to the accepted task during the live workflow; it does not authorize a token transfer or a new execution. Recovery after interruption is deferred.

“Authorization never used on execution failure” means this framework never submits it for settlement. A signed EIP-3009 authorization remains valid until expiry/cancellation; verification alone does not revoke it. Do not promise cryptographic cancellation merely because application execution failed. Discard the in-memory proof on terminal failure; add on-chain cancellation only if separately required.

This ordering deliberately exposes Agent 2 to computation cost before settlement succeeds. There is no atomic exchange or guaranteed payment for successful computation; escrow or a new payment contract is outside the requested modification.

## 8. Files and additional components

All paths below are relative to Iterate#1 after baseline source is copied:

| Area | Planned files/change |
| --- | --- |
| Project setup | `package.json`, lockfile, TypeScript/Hardhat config, `.gitignore`, `.env.example`, root README; independent install and deployment |
| Directory | New `contracts/AgentRegistry.sol`, `packages/shared/src/registry.ts`; modify `local.ts`, `card.ts`, fixture script |
| LLM runtime | New `packages/llm/src/provider.ts`, `runtime.ts`, shared schema/config; separate agent prompts |
| Agent 1 | New `apps/client/src/agent1.ts`, `tools.ts`, experiment CLI entry and host-managed `GetTask` loop; refactor `run.ts` and `payment.ts` for nonblocking submission and receipt capture on polls |
| Agent 2 | Modify `apps/server/src/service.ts`; add execution/result staging module and LLM-backed specialist executor |
| Modified framework | Rewrite lifecycle in `payment-gate.ts`; add durable A2A task store, background workers, `GetTask` routing/access control, private staging and duplicate prevention |
| Facilitator | Preserve independent SDK verify/settle; adjust validity profile only if needed; retain idempotent transaction reconciliation |
| Evidence | New experiment record writer/verifier and `scripts/iteration1-check.ts` |
| Dashboard | Redesign `apps/dashboard` frontend and backend; add shared sanitized event schemas, live event transport, agent panels, protocol timeline, task polling view and payment/evidence inspector |
| Regression | Adapt lifecycle-sensitive checks and add independent live-LLM experiment reproduction |

Preserve useful token, card, nonce, chain-reset, signer-isolation and transaction-recovery checks. Tests asserting “settlement before execution” must be replaced for this modified profile; running the old M0–M7 suite unchanged would not validate the new architecture. The original project remains available as the reference for the earlier ordering.

### Web dashboard for the whole experiment

Build a polished web dashboard as a required deliverable of this iteration. It must let a viewer understand what both LLM agents are doing, how they communicate, and how the extended A2A protocol controls execution, payment and result delivery during an actual run. Reuse the baseline's useful process controls and event infrastructure, but redesign the interface around this experiment rather than retaining a statistics-demo layout.

Use a clear visual hierarchy: a compact run header with the current phase and infrastructure health, two prominent agent workspaces, a central communication timeline, and expandable protocol/payment details. Establish consistent typography, spacing, restrained colors and accessible status indicators. Give each agent a stable visual identity, label statuses in text as well as color, support keyboard navigation and reduced motion, and adapt the layout to narrower screens. Animation should indicate observed activity; it must not simulate progress or invent agent behavior.

The dashboard must include:

| View | Required behavior |
| --- | --- |
| Experiment controls and overview | Enter the original task and constraints, start a run, see chain/registry/server/facilitator/model configuration readiness, and follow the original task ID and overall status. Distinguish starting a fresh run from viewing an existing run; never silently resubmit an interrupted delegation. |
| Agent 1 workspace | Show its task, model identifier, current activity, public tool calls and sanitized results: directory lookup, card discovery, delegation, challenge validation, signing summary, paid retry, polling, result receipt and final response. Show actual model-call start/end and available usage/latency without exposing hidden reasoning. |
| Agent 2 workspace | Show request acceptance, authorization verification, model execution, output-validation status, private result staged, settlement pending/confirmed, and result publication. Before settlement, show only execution status and safe timing/usage summaries; reveal its assessment only after the delivery gate opens. |
| Live communication and protocol timeline | Render a sequence view with Agent 1, registry/local chain, Agent 2 and facilitator lanes. Connect the observed directory/card reads, unpaid `SendMessage`, HTTP 402, paid retry, verification, Task acknowledgement, repeated `GetTask`, execution, settlement and completed Task delivery. Highlight the current event and let the viewer select earlier events. Collapse repetitive polls while retaining their count, timestamps and individual details. |
| A2A/x402 inspector | Display message/task/context IDs, extension activation, actual method names, HTTP statuses, safe challenge terms and sanitized request/response envelopes. Show A2A task state separately from execution/payment phases, with the relationship made explicit. Display signing as an authorization-created event with a public summary, never the raw `PAYMENT-SIGNATURE`. |
| Payment and evidence | Show configured price, asset/network/payee, observed balances, authorization validity, verification outcome, settlement submission, transaction hash, confirmation and receipt checks. Link each payment to its delegated message and A2A task. Provide the sanitized experiment evidence for download and show Agent 1's final output alongside the released specialist result. |
| Failure and interruption | Explain the failed phase using sanitized errors. Clearly distinguish execution failure with no settlement, settlement failure with withheld output, and unresolved interruption. Retain known IDs/hash and the last observed state; do not infer that an unresolved request is unpaid or canceled. |

Instrument the actual host tools, A2A adapter, task store, model runtime and facilitator with a shared event contract. Each event carries its run/task correlation, source, event ID, source sequence and timestamp, plus an allowlisted payload. Preserve causal links and source ordering rather than claiming timestamps establish a perfect total order across processes. The UI must consume real events and snapshots, including idle, pending, failed and disconnected states, rather than advancing a scripted walkthrough independently of backend work.

Use a backend-to-browser event stream, such as the existing SSE mechanism, with bounded history and event-ID deduplication. This dashboard transport is separate from **Agent 1's A2A `GetTask` polling**, which remains the agent interaction method; label that distinction in the protocol view. Reconnecting the browser may restore its sanitized view of the existing run, but must not restart an agent workflow, resume an interrupted payment session or create new payments. Surface event gaps/disconnection and refresh a read-only snapshot when needed. Keep process-local manual checkpoints optional, explicit and compatible with authorization expiry; the ordinary run should complete without clicking through each protocol step.

Enforce privacy and delivery rules on the dashboard backend before events reach the browser. Browser feeds, snapshots, logs and downloadable evidence must exclude credentials, keys, raw signed proofs, hidden reasoning and the private staged result. Do not send withheld content to the browser and merely hide it in the UI. Reuse bounded sanitized public history and isolated signer processes; expose only fixed, validated experiment controls through the local dashboard API.

Implement the dashboard alongside backend event instrumentation, then finish its layout and interactions once the end-to-end lifecycle works. Browser verification must cover a real successful run, execution failure without settlement, settlement pending/failure with withheld content, and unresolved interruption. Check that agent panels and the timeline match actual events, polling remains visible without overwhelming the view, reconnecting does not trigger work, and pre-settlement payloads contain no staged output. Visually review desktop and narrow layouts, loading/empty/error states, keyboard focus and readable status labels. A static mockup alone does not satisfy this deliverable.

## 9. Evidence, verification and completion

Write a sanitized `evidence/iteration-1-result.json` containing the original task/ID, directory/card provenance, delegated request/ID, A2A task ID, polling events and terminal/unresolved status, selected model identifiers, bounded public tool events, Agent 2's assessment, payment transaction hash, independently checked receipt/token events, and Agent 1's final output. Record token usage where available, but never credentials, keys, raw signed payment proofs or hidden model reasoning.

The observed event sequence must show:

`directory lookup → unpaid nonblocking SendMessage → HTTP 402 → challenge validation → signing → paid retry → verification → Task acknowledgement → GetTask polling during execution/settlement → confirmed settlement → completed Task with result artifact and payment receipt → Agent 1 final output`.

Server events additionally establish `LLM execution success → private result staged → settlement submitted → confirmed → artifact published`. Polling and server work interleave; evidence must not imply every intermediate state was observed by a poll.

Protocol/state-machine tests should use controllable model adapters to inject failures and verify exact payment/delivery invariants. The final experiment must additionally run both real LLMs; mocks do not satisfy the objective. Evaluate live success using schema validity, actual delegation, payment evidence and observable result incorporation rather than exact generated text.

Required checks include execution failure with no `/settle` invocation, unchanged token balances and unused nonce; no result leakage before confirmation; settlement failure/pending after successful execution; duplicate submissions without duplicate work; polls that neither charge nor execute; durable message/task association; task ownership enforcement; no unpaid content in history/artifacts/metadata; lost responses and polling deadline reported as unresolved without automatic resubmission; expired authorization; crash with staged-result preservation and no automatic resumption; executing-state crash without automatic model rerun; registry/deployment mismatch; and secret-free evidence. Update browser integration and visually verify the new order and status labels.

Delivery order: independent project setup → directory/fixture → model adapter and both agents → modified execution/payment lifecycle and A2A task polling, with shared dashboard event instrumentation → evidence/unresolved reporting → dashboard integration and visual refinement → full verification. The provider/model configuration is now selected: NVIDIA-hosted Nemotron 3.5 Lightning for both agents, as authorized during failure diagnosis. The architecture and payment ordering are fixed by the user's revision.

Completion requires one fresh live run from Iterate#1 in which both agents invoke LLMs, Agent 1 discovers Agent 2 through its blockchain tool, the delegated task succeeds before settlement, Agent 1 polls the returned task through `GetTask`, a real local token payment confirms before result release, and Agent 1 incorporates that result into its final response. A separate controlled failure run must demonstrate that unsuccessful execution never consumes its authorization through this framework.

Completion also requires the working web dashboard to display that live run: both agents' observed activities, their A2A communication and polling, the verify–execute–settle–release sequence, payment evidence and final output. Its failure/unresolved views, delivery privacy and responsive visual design must pass the browser checks above.

## 10. Baseline source references

These links identify the earlier implementation inspected for this proposal; the planned project will contain its own modified copies.

- [Baseline README](../Build/README.md) and [decisions](../Build/DECISIONS.md)
- [Client flow](../Build/apps/client/src/run.ts) and [payment transport](../Build/apps/client/src/payment.ts)
- [Service executor](../Build/apps/server/src/service.ts) and [payment gate](../Build/apps/server/src/payment-gate.ts)
- [Facilitator](../Build/scripts/facilitator.mjs), [durable storage](../Build/packages/shared/src/store.ts), and [deployment validation](../Build/packages/shared/src/local.ts)
- [Card validation](../Build/packages/shared/src/card.ts), [AgentCard](../Build/contracts/AgentCard.sol), and [TestUSD](../Build/contracts/TestUSD.sol)
- [Dashboard](../Build/apps/dashboard/src/index.ts), [UI check](../Build/scripts/ui-check.mjs), and [reproduction runner](../Build/scripts/reproduce.mjs)
- Referenced Codex task `01a172ba-75c3-73d1-9940-43afd8e83ee5`, previously read through `read_thread` for baseline context.
