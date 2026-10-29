import { defineConfig } from 'hardhat/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  solidity: {
    version: '0.8.38',
    // Resolve an absolute path: Hardhat loads this from its compiler runner.
    path: fileURLToPath(import.meta.resolve('solc/soljson.js')),
    preferWasm: true,
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 } },
  },
});
