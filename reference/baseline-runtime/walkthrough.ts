import crypto from 'node:crypto';

// IPC is available only to dashboard-owned children. Normal CLI execution is unchanged.
export const walkthroughEnabled = process.env.LOCAL_WALKTHROUGH === '1' && typeof process.send === 'function';
const armed = new Set<string>();
const pending = new Map<string, { runId: string; resolve: () => void; reject: (error: Error) => void }>();
if (walkthroughEnabled) {
  process.on('message', (message: any) => {
    if (message?.kind === 'arm' && typeof message.runId === 'string') armed.add(message.runId);
    if (message?.kind === 'continue') {
      const wait = pending.get(message.checkpointId);
      if (wait && wait.runId === message.runId) wait.resolve();
    }
    if (message?.kind === 'cancel') {
      armed.delete(message.runId);
      for (const wait of pending.values()) if (wait.runId === message.runId) wait.reject(new Error('Walkthrough cancelled; inspect payment state before another attempt'));
    }
  });
  process.on('disconnect', () => {
    for (const wait of pending.values()) wait.reject(new Error('Dashboard disconnected; inspect payment state before another attempt'));
  });
}
export function emit(source: string, type: string, runId?: string, data?: unknown) {
  if (walkthroughEnabled && process.connected) process.send!({ kind: 'event', source, type, runId, timestamp: new Date().toISOString(), data });
}
// Live-only delivery for the signed payment proof. This event must never enter
// the normal event ring, run history, logs, or exported evidence.
export function emitTransient(type: string, runId: string, data: unknown) {
  if (walkthroughEnabled && process.connected) process.send!({ kind: 'transient', type, runId, data });
}
export async function checkpoint(source: string, stage: string, runId: string, data?: unknown) {
  if (!walkthroughEnabled || (source !== 'client' && !armed.has(runId))) return;
  const checkpointId = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => pending.get(checkpointId)?.reject(new Error(`Walkthrough paused for 60 seconds at ${stage}; inspect payment state before continuing`)), 60_000);
    pending.set(checkpointId, { runId, resolve, reject });
    emit(source, 'checkpoint', runId, { stage, checkpointId, expiresAt: Date.now() + 60_000, details: data });
    // A resolved checkpoint is removed before the next one can be released.
    const cleanup = () => { clearTimeout(timer); pending.delete(checkpointId); };
    const item = pending.get(checkpointId)!;
    item.resolve = () => { cleanup(); resolve(); };
    item.reject = error => { cleanup(); reject(error); };
  }).finally(() => { pending.delete(checkpointId); });
}
