> Build a working experiment in which two agents discover one another, communicate through a reimplementation of the A2A–x402 extension, and complete a micropayment using a local copy of x402. Agent 1 discovers Agent 2 by reading its AgentCard from a preconfigured address in a local blockchain registry.
> 

## Experiment flow

1. Give Agent 1 a task and access to the local blockchain’s AgentCard registry.
2. Agent 1 reads Agent 2’s AgentCard from the preconfigured registry address and uses it to connect to Agent 2.
3. Agent 1 delegates at least one task to Agent 2 through the reimplemented A2A–x402 extension.
4. Agent 2 completes the task and receives a micropayment through the local x402 implementation, settled on the local blockchain.
5. Agent 1 receives the result and uses it to complete the original task.

## Success criteria

The experiment succeeds when Agent 1 discovers Agent 2 from its on-chain AgentCard, delegates a task, a payment is verifiably settled, and Agent 1 incorporates Agent 2’s result. Record the delegated task or request ID, payment transaction hash, and final output as evidence.