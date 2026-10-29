import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { durable } from '../../shared/src/store.js';
export interface ExperimentEvent { id: string; source: string; sequence: number; timestamp: string; type: string; runId: string; messageId?: string; taskId?: string; data: Record<string, unknown> }
// Only these public fields can enter dashboard/evidence history. Model content is
// emitted only by the client after confirmed delivery; server staging emits no text.
const fields = new Set(['message', 'method', 'status', 'state', 'phase', 'model', 'durationMs', 'usage', 'tool', 'input', 'output', 'card', 'provenance', 'terms', 'amount', 'asset', 'network', 'payTo', 'transaction', 'payer', 'nonce', 'validBefore', 'receipt', 'before', 'after', 'poll', 'latencyMs', 'request', 'response', 'runMode']);
const sensitive = /private.?key|signature|authorization$|credential|access.?token|api.?key|secret|reasoning|stagedResult/i;
export function publicData(value: unknown, key = ''): any {
  if (sensitive.test(key)) return '[omitted]';
  if (typeof value === 'string') return value.replace(/0x[\da-f]{130,}/gi, '[signature omitted]').slice(0, 24000);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(x => publicData(x));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !sensitive.test(k)).map(([k, v]) => [k, publicData(v, k)]));
  return value;
}
let sequence = 0;
export const events = new EventEmitter();
export function event(source: string, type: string, runId: string, data: Record<string, unknown> = {}, ids: { messageId?: string; taskId?: string } = {}) {
  const item: ExperimentEvent = { id: crypto.randomUUID(), source, sequence: ++sequence, timestamp: new Date().toISOString(), type, runId, ...ids, data: publicData(Object.fromEntries(Object.entries(data).filter(([k]) => fields.has(k)))) };
  // One append per event; each process has its own journal. The dashboard merges
  // records by event ID and retains source ordering, not a fabricated global clock.
  fs.mkdirSync('runtime/events', { recursive: true, mode: 0o700 });
  fs.appendFileSync(`runtime/events/${process.pid}.jsonl`, JSON.stringify(item)+'\n', { mode: 0o600 });
  events.emit('event', item);
  if (process.connected) process.send?.({ kind: 'experiment-event', event: item });
  return item;
}
export interface RunRecord { id: string; task: string; status: 'running' | 'completed' | 'failed' | 'unresolved'; startedAt: string; mode: string; messageId?: string; taskId?: string; transaction?: string; output?: string; assessment?: unknown; error?: string; provenance?: unknown; receipt?: unknown; before?: unknown; after?: unknown; models?: unknown }
export function runStore() { return durable<Record<string, RunRecord>>('runtime/runs.json', {}); }
export function readRunEvents(runId: string, messageId?: string): ExperimentEvent[] {
  if (!fs.existsSync('runtime/events')) return [];
  return fs.readdirSync('runtime/events').filter(f => f.endsWith('.jsonl')).flatMap(file =>
    fs.readFileSync(`runtime/events/${file}`, 'utf8').split('\n').flatMap(line => {
      try { const e = JSON.parse(line); return e.runId === runId || (messageId && e.messageId === messageId) ? [e] : []; }
      catch { return []; }
    })
  ).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence-b.sequence);
}
