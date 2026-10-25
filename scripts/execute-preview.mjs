import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {parseEther} from 'viem';
import {ROOT,publicClient,json} from './lib.mjs';

const step=process.argv[2];
if(!['factory','launch','seed','operator-gas','approve','authorize'].includes(step)||process.argv[3]!=='--user-confirmed')throw new Error('Named preview and explicit user confirmation required');
const preview=JSON.parse(await readFile(new URL(`.secrets/${step}-preview.json`,ROOT),'utf8'));
const request=JSON.parse(await readFile(new URL(`.secrets/${step}-request.json`,ROOT),'utf8'));
if(!preview.success||!preview.data?.requestId)throw new Error('No successful preview');
if(Number(preview.data.expiresAt)<=Date.now())throw new Error('Preview expired: re-preview and obtain confirmation again');
const baw=new URL('node_modules/.bin/baw',ROOT).pathname;
function command(args){return new Promise((resolve,reject)=>{
 const child=spawn(baw,[...args,'--json'],{stdio:['ignore','pipe','pipe']});let out='',err='';
 child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
 child.on('close',code=>{try{resolve(JSON.parse(out));}catch{reject(new Error(`Wallet command failed ${code}: ${err}`));}});
});}
const settings=await command(['wallet','settings']);
if(!settings.success||settings.data?.devMode?.enabled!==true)throw new Error('Developer Mode is not enabled; no execution sent');
const stateFile=new URL('artifacts/deployment.json',ROOT);
let state={chainId:56,maxTotalSpend:parseEther('0.02').toString(),transactions:[]};
try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(state.transactions.some(t=>t.step===step))throw new Error('Step already recorded; inspect receipt instead of replaying');
if(state.transactions.some(t=>!['success','reverted'].includes(t.status)))throw new Error('Resolve the pending transaction before another spend');
const client=publicClient();
const spent=state.transactions.reduce((sum,t)=>sum+BigInt(t.gasCost??0)+(t.status==='success'?BigInt(t.value??0):0n),0n);
const gas=await client.estimateGas({account:request.from,to:request.to,data:request.data,value:BigInt(request.value)});
const gasPrice=await client.getGasPrice();
if(spent+BigInt(request.value)+gas*gasPrice*2n>BigInt(state.maxTotalSpend))throw new Error('Current estimate exceeds approved aggregate budget');
const outcome=await command(['contract-call','execute','--requestId',preview.data.requestId]);
await mkdir(new URL('artifacts/',ROOT),{recursive:true});
await writeFile(new URL(`.secrets/${step}-execute.json`,ROOT),json(outcome),{mode:0o600});
if(!outcome.success){console.log(json(outcome));process.exitCode=1;}
else if(outcome.data.status==='PENDING_CONFIRMATION'){
 state.transactions.push({step,status:'pending-confirmation',orderId:outcome.data.orderId});await writeFile(stateFile,json(state));
 console.log(json({step,status:'PENDING_CONFIRMATION',message:'Approve this transaction in Binance App; do not execute it again'}));
}
else if(outcome.data.status==='BROADCASTED'&&outcome.data.txHash){
 const hash=outcome.data.txHash;
 state.transactions.push({step,hash,status:'submitted'});await writeFile(stateFile,json(state));
 console.log(json({step,hash,status:'submitted'}));
 const receipt=await client.waitForTransactionReceipt({hash});const tx=await client.getTransaction({hash});
 const entry=state.transactions.find(t=>t.hash===hash);
 Object.assign(entry,{status:receipt.status,gasUsed:receipt.gasUsed,gasPrice:receipt.effectiveGasPrice,gasCost:receipt.gasUsed*receipt.effectiveGasPrice,value:tx.value,block:receipt.blockNumber});
 await writeFile(stateFile,json(state));console.log(json(entry));
 if(receipt.status!=='success')process.exitCode=1;
}else throw new Error(`Unexpected execute status: ${outcome.data?.status}; inspect saved result, do not replay`);
