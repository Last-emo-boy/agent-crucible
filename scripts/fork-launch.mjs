import { createWalletClient, http, parseAbi, parseEther, encodeFunctionData } from 'viem';
import { bsc } from 'viem/chains';
import { publicClient, ADDRESSES, artifact, factoryDeployment, tokenSalt, launchParams, json } from './lib.mjs';

process.on('uncaughtException',error=>{
  console.error(error.shortMessage??error.message);
  const cause=error.walk?.(item=>typeof item.data==='string' && item.data.startsWith('0x'));
  if(cause)console.error(`revert data: ${cause.data}`);
  let item=error;
  for(let i=0;item && i<5;i++,item=item.cause)console.error(JSON.stringify({type:item.name,code:item.code,details:item.details,data:typeof item.data==='string'?item.data:undefined}));
  process.exit(1);
});

// Writes are intentionally restricted to a local Anvil fork. Never mainnet.
const url='http://127.0.0.1:18545';
const client=publicClient(url);
const version=await client.request({method:'web3_clientVersion'});
if(!version.toLowerCase().includes('anvil')) throw new Error('Local Anvil required');
if(await client.getChainId()!==56) throw new Error('BSC fork required');
const creator='0x6a755fA47b21592b3fB039F63933d367C0DD1985';
await client.request({method:'anvil_impersonateAccount',params:[creator]});
await client.request({method:'anvil_setBalance',params:[creator,'0x56bc75e2d63100000']});
const wallet=createWalletClient({account:creator,chain:bsc,transport:http(url)});
const deployment=await factoryDeployment();
const factoryExists=!!await client.getCode({address:deployment.address});
console.log(json({stage:'factory',factory:deployment.address,exists:factoryExists}));
const factoryGas=factoryExists?0n:await client.estimateGas({account:creator,to:deployment.to,data:deployment.data,value:0n});
let tx;
if(!factoryExists) {
  tx=await wallet.sendTransaction({to:deployment.to,data:deployment.data,value:0n,gas:factoryGas*12n/10n});
  await client.waitForTransactionReceipt({hash:tx});
}
const token=tokenSalt(creator,'Agent Crucible:FORK ONLY');
const params=launchParams(deployment.address,token.salt,'FORK-ONLY-NOT-PINNED-NOT-FOR-MAINNET');
const abi=(await artifact('IVaultPortal','IVaultPortal')).abi;
const data=encodeFunctionData({abi,functionName:'newTokenV6WithVault',args:[params]});
console.log(json({stage:'launch-simulation',token:token.address}));
const launchGas=await client.estimateGas({account:creator,to:ADDRESSES.vaultPortal,data,value:params.quoteAmt});
tx=await wallet.sendTransaction({to:ADDRESSES.vaultPortal,data,value:params.quoteAmt,gas:launchGas*12n/10n});
const receipt=await client.waitForTransactionReceipt({hash:tx});
if(receipt.status!=='success')throw new Error('Fork launch reverted');
const [found,info]=await client.readContract({address:ADDRESSES.vaultPortal,abi,functionName:'tryGetVault',args:[token.address]});
if(!found || info.vaultFactory.toLowerCase()!==deployment.address.toLowerCase())throw new Error('Vault registry mismatch');
const vaultAbi=(await artifact('CrucibleVault','CrucibleVault')).abi;
const game=await client.readContract({address:info.vault,abi:vaultAbi,functionName:'gameVersion'});
const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)','function decimals() view returns(uint8)']);
const balance=await client.readContract({address:token.address,abi:erc20,functionName:'balanceOf',args:[creator]});
if(balance===0n)throw new Error('Creator received no tokens');
const deposit=balance/10n;
tx=await wallet.writeContract({address:token.address,abi:erc20,functionName:'approve',args:[info.vault,deposit]});
await client.waitForTransactionReceipt({hash:tx});
tx=await wallet.writeContract({address:info.vault,abi:vaultAbi,functionName:'deposit',args:[deposit]});
await client.waitForTransactionReceipt({hash:tx});
const credit=await client.readContract({address:info.vault,abi:vaultAbi,functionName:'credits',args:[creator]});
if(credit!==deposit)throw new Error('Real Flap token deposit mismatch');
const result={fork:true,block:await client.getBlockNumber(),factory:deployment.address,token:token.address,vault:info.vault,game,factoryGas,launchGas,depositSuccessful:true,creatorTokenBalance:balance};
console.log(json(result));
