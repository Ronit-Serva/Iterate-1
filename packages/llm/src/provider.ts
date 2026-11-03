import { event } from '../../experiment/src/events.js';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelReply { message: ChatMessage; usage?: unknown }
export interface Model { id: string; complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ModelReply> }
export function modelConfig(agent: 'agent1' | 'agent2') {
  const id = process.env[`${agent.toUpperCase()}_MODEL`] ?? process.env.LLM_MODEL ?? '';
  const base = process.env.LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';
  const url = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('LLM endpoint requires HTTPS or local HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid LLM endpoint');
  const key = process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY;
  const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 2400);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 8192) throw new Error('LLM_MAX_TOKENS must be 256–8192');
  const nvidiaMistral = url.hostname === 'integrate.api.nvidia.com' && id === 'mistralai/mistral-large-4-1t-a52b';
  const nvidiaLightning = url.hostname === 'integrate.api.nvidia.com' && id === 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const reasoning = process.env.LLM_REASONING_EFFORT || (nvidiaMistral ? 'none' : undefined);
  if (reasoning && !['none', 'low', 'medium', 'high'].includes(reasoning)) throw new Error('LLM_REASONING_EFFORT must be none, low, medium or high');
  if (nvidiaMistral && !['none', 'high'].includes(reasoning!)) throw new Error('NVIDIA Mistral Large 4 supports LLM_REASONING_EFFORT=none or high; low/medium are unsupported');
  if (nvidiaLightning && reasoning) throw new Error('NVIDIA Nemotron Lightning uses LLM_REASONING_BUDGET; leave LLM_REASONING_EFFORT empty');
  const reasoningBudget = nvidiaLightning ? Number(process.env.LLM_REASONING_BUDGET || 128) : undefined;
  if (reasoningBudget !== undefined && (!Number.isInteger(reasoningBudget) || reasoningBudget < 0 || reasoningBudget >= maxTokens)) throw new Error('LLM_REASONING_BUDGET must be nonnegative and smaller than LLM_MAX_TOKENS');
  return { id, base: base.replace(/\/$/, ''), key, ready: Boolean(id && (local || key)), local, maxTokens, reasoning, reasoningBudget };
}
export function createModel(agent: 'agent1' | 'agent2', runId: string): Model {
  const config = modelConfig(agent);
  if (!config.ready) throw new Error('Configure LLM_MODEL (or AGENT1_MODEL/AGENT2_MODEL), LLM_BASE_URL and a server-side NVIDIA_API_KEY or LLM_API_KEY');
  // Provider-only continuation state. Never attach hidden reasoning to returned
  // messages, tool results, events, evidence, or the other agent's context.
  const privateReasoning = new WeakMap<ChatMessage, string>();
  return { id: config.id, async complete(messages, tools) {
    const started = Date.now();
    event(agent, 'model-start', runId, { model: config.id });
    let response: Response;
    try {
      const providerMessages = messages.map(m => privateReasoning.has(m) ? { ...m, reasoning_content: privateReasoning.get(m) } : m);
      response = await fetch(`${config.base}/chat/completions`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify({ model: config.id, messages: providerMessages, max_tokens: config.maxTokens, stream: false, temperature: 1, top_p: 0.95, ...(config.reasoning ? { reasoning_effort: config.reasoning } : {}), ...(config.reasoningBudget !== undefined ? { reasoning_budget: config.reasoningBudget } : {}), ...(tools?.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) }), signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      const message = timedOut ? 'Model provider timed out after 90 seconds before response headers; no automatic retry' : 'Model provider connection failed before response headers; no automatic retry';
      event(agent, 'model-error', runId, { message, status: timedOut ? 'timeout' : 'connection-failed', model: config.id, durationMs: Date.now()-started }); throw new Error(message);
    }
    if (!response.ok) {
      const message = `Model provider HTTP ${response.status}${response.status === 401 ? ': credential rejected' : response.status === 429 ? ': rate limit exceeded' : response.status === 402 ? ': API credit required' : response.status === 400 || response.status === 422 ? ': request parameters rejected' : ': provider request failed'}`;
      const requestId = response.headers.get('x-request-id');
      event(agent, 'model-error', runId, { message, status: response.status, model: config.id, durationMs: Date.now()-started, ...(requestId && /^[\w:-]{1,128}$/.test(requestId) ? { response: { requestId } } : {}) });
      await response.body?.cancel(); throw new Error(message); // Never expose provider response bodies.
    }
    const text = await response.text();
    if (text.length > 500_000) throw new Error('Oversized model response');
    const body = JSON.parse(text); const choice = body.choices?.[0]; const raw = choice?.message;
    const usage = body.usage ? { prompt_tokens: body.usage.prompt_tokens, completion_tokens: body.usage.completion_tokens, total_tokens: body.usage.total_tokens } : undefined;
    event(agent, 'model-end', runId, { model: config.id, durationMs: Date.now()-started, usage, response: { finishReason: choice?.finish_reason, refused: Boolean(raw?.refusal), hasText: Boolean(raw?.content), toolCalls: raw?.tool_calls?.length ?? 0 } });
    if (!raw || raw.refusal || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Model refused, truncated, or returned invalid completion');
    if (typeof raw.content !== 'string' && !Array.isArray(raw.tool_calls)) throw new Error('Empty model completion');
    const message: ChatMessage = { role: 'assistant', content: raw.content ?? null };
    if (typeof raw.reasoning_content === 'string' && raw.reasoning_content) privateReasoning.set(message, raw.reasoning_content);
    if (raw.tool_calls?.length) {
      if (raw.tool_calls.length !== 1 || raw.tool_calls[0].type !== 'function') throw new Error('Expected one function tool call per model turn');
      message.tool_calls = raw.tool_calls.map((t: ToolCall) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } }));
    }
    return { message, usage };
  } };
}
