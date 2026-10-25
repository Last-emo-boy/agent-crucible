import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {encodeFunctionData,isAddress,parseAbi,parseEther,parseUnits} from 'viem';
import {ROOT,ADDRESSES,publicClient,artifact,json} from './lib.mjs';

const {values}=parseArgs({options:{operator:{type:'string'},deposit:{type:'string'},'per-round':{type:'string'},'valid-seconds':{type:'string',default:'86400'}}});
if(!isAddress(values.operator??''))throw new Error('The approved operator address is required');
const plan=JSON.parse(await readFile(new URL('artifacts/launch-plan.json',ROOT)));
const client=publicClient();
if(await client.getChainId()!==56)throw new Error('BSC mainnet required');
const registry=(await artifact('IVaultPortal','IVaultPortal')).abi;
const [found,info]=await client.readContract({address:ADDRESSES.vaultPortal,abi:registry,functionName:'tryGetVault',args:[plan.token.address]});
if(!found||info.vaultFactory.toLowerCase()!==plan.factory.address.toLowerCase())throw new Error('Unexpected token/factory association');
const vaultAbi=(await artifact('CrucibleVault','CrucibleVault')).abi;
const controller=await client.readContract({address:info.vault,abi:vaultAbi,functionName:'controller'});
if(controller.toLowerCase()!==plan.creator.toLowerCase())throw new Error('Unexpected controller');
const actions={chainId:56,creator:plan.creator,token:plan.token.address,vault:info.vault,operator:values.operator,
  seed:{to:info.vault,value:parseEther('0.005'),data:encodeFunctionData({abi:vaultAbi,functionName:'fundPrize'})},
  'operator-gas':{to:values.operator,value:parseEther('0.001'),data:'0x'},
};
if(values.deposit){
  const amount=parseUnits(values.deposit,18),perRound=parseUnits(values['per-round']??'',18);
  const lifetime=BigInt(values['valid-seconds']);
  if(amount<=0n||perRound<=0n||perRound>amount||lifetime<=0n||lifetime>2592000n)throw new Error('Invalid deposit, per-round cap or expiry');
  const expiry=(await client.getBlock()).timestamp+lifetime;
  actions.policy={deposit:amount,riskBudget:amount,perRound,expiry};
  actions.approve={to:plan.token.address,value:0n,data:encodeFunctionData({abi:parseAbi(['function approve(address spender,uint256 amount) returns (bool)']),functionName:'approve',args:[info.vault,amount]})};
  actions.authorize={to:info.vault,value:0n,data:encodeFunctionData({abi:vaultAbi,functionName:'depositAndAuthorize',args:[amount,values.operator,amount,perRound,expiry]})};
}
await writeFile(new URL('artifacts/vault-actions.json',ROOT),json(actions));
console.log(json({chainId:56,creator:actions.creator,token:actions.token,vault:actions.vault,operator:actions.operator,policy:actions.policy,steps:Object.keys(actions).filter(key=>actions[key]?.data)}));
