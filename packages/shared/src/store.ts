import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Deployment } from './local.js';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
export function statePath(config: Deployment, name: string) { return `runtime/${config.anchor.blockHash}/${name}.json`; }
export function durable<T>(file: string, initial: T) {
  let state: T;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = initial; }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  return { state, save };
}
