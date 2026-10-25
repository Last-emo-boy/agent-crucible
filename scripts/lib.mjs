import { readFile } from 'node:fs/promises';
import { createPublicClient, http, encodeDeployData, getContractAddress, concat, keccak256, stringToHex, zeroAddress, zeroHash, encodeAbiParameters, parseEther } from 'viem';
import { bsc } from 'viem/chains';

export const ROOT = new URL('../', import.meta.url);
export const ADDRESSES = Object.freeze({
  portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
  vaultPortal: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06',
  taxImplementation: '0x024f18294970B5c76c0691b87f138A0317156422',
  agentId: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',
  deployer: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
});
export const DEPLOYER_CODE = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

export function publicClient(url = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org') {
  return createPublicClient({ chain: bsc, transport: http(url, { timeout: 20000, retryCount: 1 }) });
}

export async function artifact(file, name) {
  return JSON.parse(await readFile(new URL(`out/${file}.sol/${name}.json`, ROOT), 'utf8'));
}

export async function factoryDeployment() {
  const build = await artifact('CrucibleFactory', 'CrucibleFactory');
  const initCode = encodeDeployData({ abi: build.abi, bytecode: build.bytecode.object, args: [ADDRESSES.agentId] });
  const salt = keccak256(stringToHex('agent-crucible:factory:v1'));
  const address = getContractAddress({ from: ADDRESSES.deployer, opcode: 'CREATE2', salt, bytecode: initCode });
  return { address, salt, to: ADDRESSES.deployer, data: concat([salt, initCode]), value: 0n };
}

export function tokenSalt(creator, namespace = 'Agent Crucible:CRUX:v1') {
  const cloneCode = concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', ADDRESSES.taxImplementation, '0x5af43d82803e903d91602b57fd5bf3']);
  let salt = keccak256(stringToHex(`${creator.toLowerCase()}:${namespace}`));
  for (let i = 0; i < 2_000_000; i++) {
    const address = getContractAddress({ from: ADDRESSES.portal, opcode: 'CREATE2', salt, bytecode: cloneCode });
    if (address.toLowerCase().endsWith('7777')) return { salt, address };
    salt = keccak256(salt);
  }
  throw new Error('Vanity search exhausted; choose a new explicit namespace');
}

export function launchParams(factory, salt, metadataCid, buy = '0.01') {
  if (!metadataCid) throw new Error('A Flap-pinned metadata CID is required');
  return {
    name: 'Agent Crucible', symbol: 'CRUX', meta: metadataCid,
    dexThresh: 1, salt, migratorType: 1, quoteToken: zeroAddress,
    quoteAmt: parseEther(buy), permitData: '0x', extensionID: zeroHash,
    extensionData: '0x', dexId: 0, lpFeeProfile: 0,
    buyTaxRate: 100, sellTaxRate: 100, taxDuration: 31536000n,
    antiFarmerDuration: 0n, mktBps: 10000, deflationBps: 0,
    dividendBps: 0, lpBps: 0, minimumShareBalance: 0n,
    dividendToken: zeroAddress, commissionReceiver: zeroAddress,
    tokenVersion: 6, vaultFactory: factory,
    vaultData: encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'}], [parseEther('0.001'), 1200n, 600n]),
  };
}

export function json(value) { return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2); }
