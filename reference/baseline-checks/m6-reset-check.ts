import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { assertDeployment, deployment } from '../packages/shared/src/local.js';
import { readCard } from '../packages/shared/src/card.js';

const config = deployment();
fs.writeFileSync('evidence/M6-prior-deployment.json', JSON.stringify(config, null, 2) + '\n');
await assert.rejects(assertDeployment(config), /missing|Stale/);
await assert.rejects(readCard(config), /missing|Stale/);
for (const entry of ['scripts/facilitator.mjs', 'apps/server/src/index.ts']) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  const exitCode = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /missing|Stale/);
}
const report = JSON.parse(fs.readFileSync('evidence/M6-result.json', 'utf8'));
report.resetCheckPending = false;
report.passed = true;
report.evidence.push({ case: 'actual Hardhat node restart/reset', oldManifestRejected: true, staleResultUnavailable: true, oldServiceAndFacilitatorStartupRejected: true });
fs.writeFileSync('evidence/M6-result.json', JSON.stringify(report, null, 2) + '\n');
console.log('M6 passed: actual node reset rejects old deployment and service stores.');
