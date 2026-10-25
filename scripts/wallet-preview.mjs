import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {ROOT,json} from './lib.mjs';

const plan=JSON.parse(await readFile(new URL('artifacts/launch-plan.json',ROOT),'utf8'));
const {values,positionals}=parseArgs({options:{'gas-limit':{type:'string'}},allowPositionals:true});
const step=positionals[0];
const gasLimit=values['gas-limit'];
if(gasLimit && (!/^\d+$/.test(gasLimit)||Number(gasLimit)<21000||Number(gasLimit)>15000000))throw new Error('Gas limit must be an integer from 21000 to 15000000');
const actions=['seed','operator-gas','approve','authorize'].includes(step)?JSON.parse(await readFile(new URL('artifacts/vault-actions.json',ROOT),'utf8')):null;
if(actions&&(actions.chainId!==56||actions.creator.toLowerCase()!==plan.creator.toLowerCase()))throw new Error('Prepared actions have the wrong chain or owner');
const transaction=step==='factory'?plan.factory:step==='launch'?plan.launch:actions?.[step];
if(!transaction)throw new Error('A prepared named transaction is required');
const args=['contract-call','preview','--binanceChainId','56','--from',plan.creator,'--to',transaction.to,'--value',transaction.value,'--inputData',transaction.data,'--json'];
if(gasLimit)args.push('--gasLimit',gasLimit);
const result=await new Promise((resolve,reject)=>{
  const p=spawn(new URL('node_modules/.bin/baw',ROOT).pathname,args,{stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);
  p.on('close',code=>{try{resolve(JSON.parse(out));}catch{reject(new Error(`Wallet preview failed (${code}): ${err}`));}});
});
await mkdir(new URL('.secrets/',ROOT),{recursive:true,mode:0o700});
await writeFile(new URL(`.secrets/${step}-preview.json`,ROOT),json(result),{mode:0o600});
await writeFile(new URL(`.secrets/${step}-request.json`,ROOT),json({from:plan.creator,to:transaction.to,data:transaction.data,value:transaction.value,gasLimit}),{mode:0o600});
if(!result.success){console.log(json(result));process.exitCode=1;}
else {
  const d=result.data;
  console.log(json({step,from:plan.creator,to:transaction.to,predictedFactory:step==='factory'?plan.factory.address:undefined,
    predictedToken:step==='launch'?plan.token.address:undefined,gasLimit,
    value:transaction.value,parsedTx:d.parsedTx,simulationResult:d.simulationResult,risks:d.risks,
    requireConfirmation:d.requireConfirmation,expiresAt:d.expiresAt}));
}
