import fs from 'node:fs/promises';
import solc from 'solc';

const source = await fs.readFile(new URL('./TransferProbe.sol', import.meta.url), 'utf8');
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'TransferProbe.sol': { content: source } },
  settings: {
    evmVersion: 'shanghai',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
  },
})));
const errors = output.errors?.filter((error) => error.severity === 'error') ?? [];
if (errors.length > 0) throw new Error(errors.map((error) => error.formattedMessage).join('\n'));

const bytecode = output.contracts['TransferProbe.sol'].TransferProbe.evm.deployedBytecode.object;
const modulePath = new URL('./probe-contract.mjs', import.meta.url);
const current = await fs.readFile(modulePath, 'utf8');
const pattern = /(export const TRANSFER_PROBE_RUNTIME_BYTECODE =\s*')0x[0-9a-f]+(';)/;
if (!pattern.test(current)) throw new Error('Cannot locate probe bytecode export');
const generated = current.replace(pattern, (_match, before, after) => `${before}0x${bytecode}${after}`);
if (process.argv.includes('--check')) {
  if (generated !== current) throw new Error('Probe bytecode is stale; run npm run build:transfer-probe');
  console.log('Probe bytecode matches TransferProbe.sol');
} else {
  await fs.writeFile(modulePath, generated);
  console.log('Updated probe-contract.mjs');
}
