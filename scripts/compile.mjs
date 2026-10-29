import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

// Use the installed official solc-js compiler without a compiler download.
const sources = Object.fromEntries(fs.readdirSync('contracts')
  .filter(name => name.endsWith('.sol'))
  .map(name => [`contracts/${name}`, { content: fs.readFileSync(`contracts/${name}`, 'utf8') }]));
const input = {
  language: 'Solidity', sources,
  settings: {
    evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
  try { return { contents: fs.readFileSync(path.join('node_modules', name), 'utf8') }; }
  catch { return { error: `Import unavailable: ${name}` }; }
}}));
for (const issue of output.errors ?? []) console.error(issue.formattedMessage);
if (output.errors?.some(issue => issue.severity === 'error')) process.exit(1);
let count = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, contract] of Object.entries(contracts)) {
    const target = `artifacts/${sourceName}`;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(`${target}/${contractName}.json`, JSON.stringify({
      contractName, sourceName, abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    }, null, 2) + '\n');
    count++;
  }
}
console.log(`Compiled ${count} contract(s) using solc ${solc.version()}`);
