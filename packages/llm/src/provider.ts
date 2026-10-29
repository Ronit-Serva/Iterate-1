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
  const reasoning = process.env.LLM_REASONING_EFFORT;
  if (reasoning && !['low', 'medium', 'high'].includes(reasoning)) throw new Error('LLM_REASONING_EFFORT must be low, medium or high');
  return { id, base: base.replace(/\/$/, ''), key, ready: Boolean(id && (local || key)), local, maxTokens, reasoning };
}
export function createModel(agent: 'agent1' | 'agent2', runId: string): Model {
  const config = modelConfig(agent);
  if (!config.ready) throw new Error('Configure LLM_MODEL (or AGENT1_MODEL/AGENT2_MODEL), LLM_BASE_URL and a server-side NVIDIA_API_KEY or LLM_API_KEY');
  return { id: config.id, async complete(messages, tools) {
    const started = Date.now();
    event(agent, 'model-start', runId, { model: config.id });
    let response: Response;
    try {
      response = await fetch(`${config.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify({ model: config.id, messages, max_tokens: config.maxTokens, stream: false, temperature: 1, top_p: 0.95, ...(config.reasoning ? { reasoning_effort: config.reasoning } : {}), ...(tools?.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) }), signal: AbortSignal.timeout(90_000) });
    } catch { event(agent, 'model-error', runId, { message: 'Model request interrupted or timed out', durationMs: Date.now()-started }); throw new Error('Model request interrupted or timed out'); }
    if (!response.ok) throw new Error(`Model provider HTTP ${response.status}`); // Never echo provider bodies containing credentials/prompts.
    const text = await response.text();
    if (text.length > 500_000) throw new Error('Oversized model response');
    const body = JSON.parse(text); const choice = body.choices?.[0]; const raw = choice?.message;
    const usage = body.usage ? { prompt_tokens: body.usage.prompt_tokens, completion_tokens: body.usage.completion_tokens, total_tokens: body.usage.total_tokens } : undefined;
    event(agent, 'model-end', runId, { model: config.id, durationMs: Date.now()-started, usage, response: { finishReason: choice?.finish_reason, refused: Boolean(raw?.refusal), hasText: Boolean(raw?.content), toolCalls: raw?.tool_calls?.length ?? 0 } });
    if (!raw || raw.refusal || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Model refused, truncated, or returned invalid completion');
    if (typeof raw.content !== 'string' && !Array.isArray(raw.tool_calls)) throw new Error('Empty model completion');
    const message: ChatMessage = { role: 'assistant', content: raw.content ?? null };
    if (raw.tool_calls?.length) {
      if (raw.tool_calls.length !== 1 || raw.tool_calls[0].type !== 'function') throw new Error('Expected one function tool call per model turn');
      message.tool_calls = raw.tool_calls.map((t: ToolCall) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } }));
    }
    return { message, usage };
  } };
}
