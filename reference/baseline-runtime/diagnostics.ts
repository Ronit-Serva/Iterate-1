export function diagnostic(error: unknown): string {
  const messages: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth++, current = current.cause) {
    messages.push(String(current.message ?? current));
    if (current.code === 'ECONNREFUSED') {
      if (current.port === 4021) return 'Server agent unavailable at http://127.0.0.1:4021. Start npm run server after deploying and starting npm run facilitator.';
      if (current.port === 4022) return 'Facilitator unavailable at http://127.0.0.1:4022. Start npm run facilitator. Inspect the current payment before retrying.';
      if (current.port === 8545) return 'Local blockchain unavailable at http://127.0.0.1:8545. Start npm run node, then npm run m1:local for a fresh chain, and restart the facilitator and server.';
    }
  }
  const message = messages[0] ?? 'Unknown error';
  if (/ENOENT.*(local.json|key.json)|contract is missing|Stale deployment|bytecode mismatch/.test(messages.join(' '))) return `${message}. Run npm run compile and npm run m1:local against the running local node, then restart the facilitator and server.`;
  return message;
}
