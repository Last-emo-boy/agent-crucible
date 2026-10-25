import { writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isAddress, encodeFunctionData } from 'viem';
import { ADDRESSES, DEPLOYER_CODE, ROOT, publicClient, artifact, factoryDeployment, tokenSalt, launchParams, json } from './lib.mjs';

const { values } = parseArgs({options:{creator:{type:'string'},metadata:{type:'string'},buy:{type:'string',default:'0.01'}}});
if (!isAddress(values.creator ?? '')) throw new Error('--creator must be the confirmed wallet address');
const client = publicClient();
if (await client.getChainId() !== 56) throw new Error('Not BSC mainnet');
if (await client.getCode({address:ADDRESSES.deployer}) !== DEPLOYER_CODE) throw new Error('Unrecognized deterministic deployer code');
const deployment = await factoryDeployment();
const factoryExists = !!await client.getCode({address:deployment.address});
const factoryGas = factoryExists ? 0n : await client.estimateGas({account:values.creator,to:deployment.to,data:deployment.data,value:0n});
const token = tokenSalt(values.creator);
if (await client.getCode({address:token.address})) throw new Error('Predicted token address occupied; do not relaunch');
const plan = {chainId:56,creator:values.creator,factory:{...deployment,exists:factoryExists,estimatedGas:factoryGas},token,gasPrice:await client.getGasPrice(),block:await client.getBlockNumber()};
if(values.metadata) {
  const params = launchParams(deployment.address,token.salt,values.metadata,values.buy);
  const portal = await artifact('IVaultPortal','IVaultPortal');
  plan.launch={to:ADDRESSES.vaultPortal,data:encodeFunctionData({abi:portal.abi,functionName:'newTokenV6WithVault',args:[params]}),value:params.quoteAmt,params};
  if(factoryExists) plan.launch.estimatedGas=await client.estimateGas({account:values.creator,...plan.launch});
}
await mkdir(new URL('artifacts/',ROOT),{recursive:true});
await writeFile(new URL('artifacts/launch-plan.json',ROOT),json(plan));
console.log(json({chainId:56,creator:plan.creator,factory:deployment.address,factoryExists,factoryGas,gasPrice:plan.gasPrice,factoryGasCost:factoryGas*plan.gasPrice,token:token.address,tokenPrepared:!!plan.launch}));
