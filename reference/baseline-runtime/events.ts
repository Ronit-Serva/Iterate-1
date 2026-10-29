import { StringDecoder } from 'node:string_decoder';

export function sanitize(value: unknown): any {
  if (typeof value === 'string') return value.replace(/0x[a-fA-F0-9]{130,}/g, '[signature omitted]');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(private.?key|signature|payment-signature|secret)$/i.test(key) ? '[omitted]' : sanitize(item)]));
  return typeof value === 'bigint' ? value.toString() : value;
}
export function sanitizeLine(line: string) {
  // Redact at ingestion, before storage or delivery. Never load a key to redact it.
  line = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (/private[\s_-]*key|payment-signature|"signature"\s*:|\bsecret\s*[:=]/i.test(line)) return '[sensitive signing material omitted]';
  return sanitize(line) as string;
}
export function lineReader(consume: (line: string) => void) {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let dropping = false;
  return {
    write(chunk: Buffer) {
      let text = decoder.write(chunk);
      if (dropping) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        text = text.slice(newline + 1); dropping = false;
      }
      partial += text;
      let end: number;
      while ((end = partial.indexOf('\n')) >= 0) {
        consume(end > 65536 ? '[oversized output omitted]' : sanitizeLine(partial.slice(0, end).replace(/\r$/, '')));
        partial = partial.slice(end + 1);
      }
      // Drop huge unbroken output rather than splitting a possibly secret-bearing line.
      if (partial.length > 65536) { partial = ''; dropping = true; consume('[oversized output omitted]'); }
    },
    end() { partial += decoder.end(); if (partial) consume(sanitizeLine(partial)); partial = ''; },
  };
}
