import {readFile} from 'node:fs/promises';
import {createPublicClient,http,parseAbi,encodeFunctionData,parseUnits,isAddress,keccak256,encodeAbiParameters} from 'viem';
import {bsc} from 'viem/chains';

export const config=JSON.parse(await readFile(new URL('../references/deployment.json',import.meta.url)));
export const abi=JSON.parse(await readFile(new URL('../references/vault-abi.json',import.meta.url)));
export const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2);
export const client=createPublicClient({chain:bsc,transport:http(process.env.BSC_RPC_URL??'https://bsc-dataseed.binance.org',{timeout:15000,retryCount:1})});
export const read=(name,args=[])=>client.readContract({address:config.vault,abi,functionName:name,args});

export async function verifyDeployment(){
  if(await client.getChainId()!==config.chainId)throw new Error('Expected BSC mainnet (56)');
  const registry=parseAbi(['function tryGetVault(address) view returns (bool,(address vault,address vaultFactory,string description,bool isOfficial,uint8 riskLevel))']);
  const [found,info]=await client.readContract({address:config.vaultPortal,abi:registry,functionName:'tryGetVault',args:[config.token]});
  if(!found||info.vault.toLowerCase()!==config.vault.toLowerCase()||info.vaultFactory.toLowerCase()!==config.factory.toLowerCase())throw new Error('Token/Vault/Factory identity does not match the published deployment');
  const [asset,version]=await Promise.all([read('asset'),read('gameVersion')]);
  if(asset.toLowerCase()!==config.token.toLowerCase()||version!==config.gameVersion)throw new Error('Unexpected game or asset');
  return {isOfficial:info.isOfficial,riskLevel:info.riskLevel};
}

export function address(value,label='address'){
  if(!isAddress(value??''))throw new Error(`${label} must be a full EVM address`);
  return value;
}

export function tokens(value){
  if(!/^\d+(\.\d{1,18})?$/.test(value??''))throw new Error('Token amount must be a non-negative decimal with at most 18 decimals');
  const amount=parseUnits(value,18);
  if(amount<=0n)throw new Error('Token amount must be greater than zero');
  return amount;
}

export function bidHash(round,owner,amount,salt){
  return keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'uint256'},{type:'address'},{type:'uint256'},{type:'bytes32'}],[56n,config.vault,round,owner,amount,salt]));
}

export function transaction(owner,name,args=[]){
  return {binanceChainId:'56',from:address(owner,'owner'),to:config.vault,value:'0',inputData:encodeFunctionData({abi,functionName:name,args}),method:name};
}

export function approveTransaction(owner,amount){
  return {binanceChainId:'56',from:address(owner,'owner'),to:config.token,value:'0',inputData:encodeFunctionData({abi:parseAbi(['function approve(address spender,uint256 amount) returns (bool)']),functionName:'approve',args:[config.vault,amount]}),method:'approve',spender:config.vault,amount:amount.toString()};
}
