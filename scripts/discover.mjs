import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isAddress } from 'viem';
import { ADDRESSES, artifact, publicClient, json } from './lib.mjs';

export function findToken(result, address) {
  if(result?.success!==true || result?.code!=='000000' || !Array.isArray(result.data)) {
    throw new Error('meme-rush returned an unsuccessful or malformed response');
  }
  return result.data.find(row=>String(row.chainId)==='56' && row.protocol===2002
    && typeof row.contractAddress==='string'
    && row.contractAddress.toLowerCase()===address.toLowerCase());
}

export function classifyReportedTaxAddress(reported,info) {
  if(!reported)return 'not-reported';
  if(reported.toLowerCase()===info.vault.toLowerCase())return 'vault';
  // Flap V6's live Binance feed currently exposes the creating factory here.
  // Resolve the receiving vault through VaultPortal, never send to this field.
  if(reported.toLowerCase()===info.vaultFactory.toLowerCase())return 'factory';
  throw new Error('Feed tax address matches neither the registered vault nor its factory');
}

export function runOfficial(cli, stage) {
  const query={chainId:'56',rankType:stage,protocol:[2002],limit:100};
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'meme-rush',JSON.stringify(query)],{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    child.stdout.on('data',chunk=>out+=chunk);
    child.stderr.on('data',chunk=>err+=chunk);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(`Official meme-rush exited ${code}: ${err}`));
      try{resolve({query,result:JSON.parse(out)});}catch(e){reject(e);}
    });
  });
}

export async function discover({token,factory,cli=join(homedir(),'.codex/skills/meme-rush/scripts/cli.mjs')}) {
  if(!isAddress(token))throw new Error('A full token contract address is required');
  const checked=[];
  let row;
  for(const stage of [10,20,30]) {
    const response=await runOfficial(cli,stage);
    checked.push({stage,count:response.result.data?.length??null});
    row=findToken(response.result,token);
    if(row)break;
  }
  if(!row)return {found:false,token,checked,reason:'Not in these bounded lifecycle feeds; this is not proof the token is unindexed.'};
  const client=publicClient();
  const abi=(await artifact('IVaultPortal','IVaultPortal')).abi;
  const [found,info]=await client.readContract({address:ADDRESSES.vaultPortal,abi,functionName:'tryGetVault',args:[token]});
  if(!found)throw new Error('Feed token has no on-chain VaultPortal association');
  const reported=row.taxFeeDistribution?.taxRateVaultAddress;
  const reportedTaxAddressKind=classifyReportedTaxAddress(reported,info);
  if(factory && factory.toLowerCase()!==info.vaultFactory.toLowerCase())throw new Error('Unexpected factory');
  const vaultAbi=(await artifact('CrucibleVault','CrucibleVault')).abi;
  const [version,asset]=await Promise.all([
    client.readContract({address:info.vault,abi:vaultAbi,functionName:'gameVersion'}),
    client.readContract({address:info.vault,abi:vaultAbi,functionName:'asset'}),
  ]);
  if(version!=='agent-crucible/1' || asset.toLowerCase()!==token.toLowerCase())throw new Error('Wrong game or asset');
  return {found:true,token,vault:info.vault,factory:info.vaultFactory,version,checked,
    reportedTaxAddress:reported,reportedTaxAddressKind,vaultSource:'VaultPortal.tryGetVault',
    buyTax:row.taxRateBuy,sellTax:row.taxRateSell,riskLevel:info.riskLevel,isOfficial:info.isOfficial};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {values}=parseArgs({options:{token:{type:'string'},factory:{type:'string'},cli:{type:'string'}}});
  const result=await discover(values);
  console.log(json(result));
  if(!result.found)process.exitCode=2;
}
