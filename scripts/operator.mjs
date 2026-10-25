import keytar from '@github/keytar';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createWalletClient,http,isAddress,parseEther,parseUnits,keccak256,encodeAbiParameters} from 'viem';
import {bsc} from 'viem/chains';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,open,unlink,rename,readdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {ROOT,artifact,publicClient,json} from './lib.mjs';

const SERVICE='agent-crucible.operator';
const ACCOUNT='bsc-v1';

export function commitment(chainId,vault,round,owner,amount,salt) {
  return keccak256(encodeAbiParameters(
    [{type:'uint256'},{type:'address'},{type:'uint256'},{type:'address'},{type:'uint256'},{type:'bytes32'}],
    [BigInt(chainId),vault,round,owner,amount,salt]));
}

export async function operationSatisfied(read,name,{round,owner,digest,maximum,bid}) {
  if(name==='finalizeRound')return (await read('rounds',[round]))[6];
  const recorded=await read('bids',[round,owner]);
  if(recorded[0]!==digest||recorded[1]!==maximum)return false;
  if(name==='commitBidFor')return true;
  if(name==='revealBid')return recorded[3]&&recorded[2]===bid;
  if(name==='claimReward')return recorded[4];
  return false;
}

export async function initializeOperator() {
  if(await keytar.getPassword(SERVICE,ACCOUNT))throw new Error('Operator already exists; refusing to replace its signing identity');
  const secret=generatePrivateKey();
  await keytar.setPassword(SERVICE,ACCOUNT,secret);
  return privateKeyToAccount(secret).address;
}

async function signer() {
  const secret=await keytar.getPassword(SERVICE,ACCOUNT);
  if(!secret)throw new Error('No approved operator in macOS Keychain');
  return privateKeyToAccount(secret);
}

async function withOperatorLock(action) {
  await mkdir(new URL('.secrets/',ROOT),{recursive:true,mode:0o700});
  const path=new URL('.secrets/operator.lock',ROOT);
  let lock;
  try{lock=await open(path,'wx',0o600);}catch(error){
    if(error.code!=='EEXIST')throw error;
    const prior=JSON.parse(await readFile(path,'utf8'));
    try{process.kill(prior.pid,0);throw new Error('Another process owns the operator; do not overlap signing jobs');}
    catch(check){if(check.code!=='ESRCH')throw check;}
    await unlink(path);lock=await open(path,'wx',0o600);
  }
  try{await lock.writeFile(json({pid:process.pid}));return await action();}
  finally{await lock.close();await unlink(path);}
}

async function operatorSpend() {
  let spent=0n;
  for(const name of await readdir(new URL('.secrets/',ROOT))){
    if(!/^(keeper-|0x[\da-f]{40}-0x[\da-f]{40}-\d+\.json$)/.test(name)||!name.endsWith('.json'))continue;
    const job=JSON.parse(await readFile(new URL(`.secrets/${name}`,ROOT),'utf8'));
    spent+=BigInt(job.gasSpent??0);
  }
  return spent;
}

export async function runRound(options) {
  return withOperatorLock(()=>executeRound(options));
}

// One pre-authorized round. The AI chooses amount/cap; this executor preserves
// the reveal obligation and cannot withdraw tokens or redirect BNB rewards.
async function executeRound({vault,owner,amount,cap,roundId,maxGas='0.0002'}) {
  if(!isAddress(vault)||!isAddress(owner))throw new Error('Full vault and owner addresses required');
  const account=await signer();
  const client=publicClient();
  if(await client.getChainId()!==56)throw new Error('BSC required');
  const wallet=createWalletClient({account,chain:bsc,transport:http(process.env.BSC_RPC_URL??'https://bsc-dataseed.binance.org')});
  const abi=(await artifact('CrucibleVault','CrucibleVault')).abi;
  const read=(name,args=[])=>client.readContract({address:vault,abi,functionName:name,args});
  if(await read('gameVersion')!=='agent-crucible/1')throw new Error('Wrong game');
  const gasLimit=parseEther(maxGas);
  const round=roundId?BigInt(roundId):await read('currentRound');
  if(round===0n)throw new Error('No round open');
  const info=await read('rounds',[round]);

  const directory=new URL('.secrets/',ROOT);
  await mkdir(directory,{recursive:true,mode:0o700});
  const stem=`${vault.toLowerCase()}-${owner.toLowerCase()}-${round}`;
  const file=new URL(`${stem}.json`,directory),lockPath=new URL(`${stem}.lock`,directory);
  let lock;
  try {lock=await open(lockPath,'wx',0o600);} catch(error) {
    if(error.code!=='EEXIST')throw error;
    const prior=JSON.parse(await readFile(lockPath,'utf8'));
    let alive=true;
    try{process.kill(prior.pid,0);}catch(check){if(check.code==='ESRCH')alive=false;else throw check;}
    if(alive)throw new Error('Another executor owns this round');
    await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
  }
  await lock.writeFile(json({pid:process.pid,createdAt:new Date().toISOString()}));
  let job;
  try {
    try{job=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!job) {
      const policy=await read('policies',[owner]);
      const now=(await client.getBlock()).timestamp;
      const bid=parseUnits(amount,18),maximum=parseUnits(cap,18);
      if(policy[0].toLowerCase()!==account.address.toLowerCase()||policy[3]<=now)throw new Error('Operator not currently authorized');
      if(bid<=0n||bid>maximum||maximum>policy[1]||maximum>policy[2]||maximum>await read('credits',[owner]))throw new Error('Bid exceeds authorized risk or deposited balance');
      if(now+60n>=info[1])throw new Error('Too late to open a safe commit; wait for next round');
      const salt=`0x${randomBytes(32).toString('hex')}`;
      job={owner,vault,round:round.toString(),amount:bid.toString(),cap:maximum.toString(),salt,phase:'prepared',gasSpent:'0'};
      await writeFile(file,json(job),{mode:0o600,flag:'wx'});
    }
    const bid=BigInt(job.amount),maximum=BigInt(job.cap);
    const digest=commitment(56,vault,round,owner,bid,job.salt);
    const satisfied=name=>operationSatisfied(read,name,{round,owner,digest,maximum,bid});
    if((amount&&parseUnits(amount,18)!==bid)||(cap&&parseUnits(cap,18)!==maximum))throw new Error('Existing commitment has different terms');
    const save=async()=>{
      const temporary=new URL(`${stem}.${process.pid}.tmp`,directory);
      await writeFile(temporary,json(job),{mode:0o600});await rename(temporary,file);
    };
    if(job.phase.startsWith('submitted:')) {
      const receipt=await client.waitForTransactionReceipt({hash:job.txHash});
      job.gasSpent=(BigInt(job.gasSpent)+receipt.gasUsed*receipt.effectiveGasPrice).toString();
      job.phase=`${receipt.status==='success'?'confirmed':'reverted'}:${job.phase.slice(10)}`;await save();
    }
    if(job.phase.startsWith('sending:'))throw new Error('Prior broadcast outcome is unknown: inspect nonce/chain before clearing the ambiguity; no replay sent');
    if(job.phase.startsWith('reverted:')) {
      const name=job.phase.slice(9);
      if(!await satisfied(name))throw new Error(`Prior transaction reverted: ${job.txHash}`);
      job.phase=`reconciled:${name}`;await save();
    }
    const send=async(name,args)=>{
      const gas=await client.estimateContractGas({account:account.address,address:vault,abi,functionName:name,args});
      const gasPrice=await client.getGasPrice();
      const gasWithMargin=gas+gas/5n;
      if(BigInt(job.gasSpent)+gasWithMargin*gasPrice>gasLimit)throw new Error('Operator gas budget exhausted');
      if(await operatorSpend()+gasWithMargin*gasPrice>parseEther('0.001'))throw new Error('Approved total operator gas budget exhausted');
      // Persist ambiguity BEFORE broadcasting. On an unknown network outcome,
      // a second process must inspect the transaction, not send it again.
      job.phase=`sending:${name}`; await save();
      const hash=await wallet.writeContract({address:vault,abi,functionName:name,args,gas:gasWithMargin,gasPrice});
      job.txHash=hash;job.phase=`submitted:${name}`;await save();
      const receipt=await client.waitForTransactionReceipt({hash});
      job.gasSpent=(BigInt(job.gasSpent)+receipt.gasUsed*receipt.effectiveGasPrice).toString();
      job.phase=`${receipt.status==='success'?'confirmed':'reverted'}:${name}`;await save();
      if(receipt.status!=='success') {
        if(!await satisfied(name))throw new Error(`Transaction reverted: ${hash}`);
        job.phase=`reconciled:${name}`;await save();
      }
      console.log(json({action:name,txHash:hash,gasSpent:job.gasSpent}));
    };
    let recorded=await read('bids',[round,owner]);
    if(recorded[0]==='0x'+'00'.repeat(32)) {
      if(job.phase!=='prepared')throw new Error('Recorded transaction and chain disagree; no replay sent');
      const policy=await read('policies',[owner]);
      const now=(await client.getBlock()).timestamp;
      if(policy[0].toLowerCase()!==account.address.toLowerCase()||policy[3]<=now||maximum>policy[1]||maximum>policy[2])throw new Error('Operator policy no longer permits this commitment');
      if(maximum>await read('credits',[owner])||now+60n>=info[1])throw new Error('Balance or commit window changed; no commitment sent');
      await send('commitBidFor',[round,owner,digest,maximum]);
      recorded=await read('bids',[round,owner]);
    }
    if(recorded[0]!==digest||recorded[1]!==maximum)throw new Error('On-chain commitment differs from the private reveal record');
    if(!recorded[3]) {
      while((await client.getBlock()).timestamp<info[1])await new Promise(resolve=>setTimeout(resolve,5000));
      if((await client.getBlock()).timestamp>=info[2])throw new Error('Reveal window expired; the locked maximum is now forfeitable');
      await send('revealBid',[round,owner,bid,job.salt]);
    } else if(recorded[2]!==bid)throw new Error('Bid was forfeited or resolved with a different amount');
    while((await client.getBlock()).timestamp<info[2])await new Promise(resolve=>setTimeout(resolve,5000));
    if(!(await read('rounds',[round]))[6])await send('finalizeRound',[round]);
    if(await read('claimable',[round,owner])>0n)await send('claimReward',[round,owner]);
    job.phase='complete';await save();
    return {owner,vault,round:round.toString(),gasSpent:job.gasSpent,status:'complete'};
  } finally {
    await lock.close();await unlink(lockPath);
  }
}

export async function runKeeper({vault,owner,action,roundId,maxGas='0.00005'}) {
  if(!isAddress(vault)||!isAddress(owner)||!['start','finalize'].includes(action))throw new Error('Keeper requires vault, owner and start/finalize action');
  return withOperatorLock(async()=>{
    const account=await signer(),client=publicClient();
    if(await client.getChainId()!==56)throw new Error('BSC required');
    const abi=(await artifact('CrucibleVault','CrucibleVault')).abi;
    const read=(name,args=[])=>client.readContract({address:vault,abi,functionName:name,args});
    if(await read('gameVersion')!=='agent-crucible/1')throw new Error('Wrong game');
    const now=(await client.getBlock()).timestamp,policy=await read('policies',[owner]);
    if(policy[0].toLowerCase()!==account.address.toLowerCase()||policy[3]<=now)throw new Error('Keeper outside approved policy window');
    const current=await read('currentRound');
    const round=action==='start'?current+1n:BigInt(roundId??current);
    if(action==='start'&&current>0n&&!(await read('rounds',[current]))[6])return {status:'round-already-open',round:current};
    if(action==='finalize'&&(await read('rounds',[round]))[6])return {status:'already-finalized',round};
    const name=action==='start'?'startRound':'finalizeRound',args=action==='start'?[]:[round];
    const file=new URL(`.secrets/keeper-${vault.toLowerCase()}-${round}-${action}.json`,ROOT);
    let job;
    try{job=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const save=async()=>{const tmp=new URL(file.href+'.tmp');await writeFile(tmp,json(job),{mode:0o600});await rename(tmp,file);};
    if(job?.phase==='sending')throw new Error('Keeper broadcast is ambiguous; inspect nonce before recovery');
    if(job?.phase==='complete')return job;
    if(!job){
      const gas=await client.estimateContractGas({account:account.address,address:vault,abi,functionName:name,args});
      const gasPrice=await client.getGasPrice(),gasWithMargin=gas+gas/5n;
      if(gasWithMargin*gasPrice>parseEther(maxGas)||await operatorSpend()+gasWithMargin*gasPrice>parseEther('0.001'))throw new Error('Keeper exceeds approved gas budget');
      job={vault,owner,round:round.toString(),action,phase:'sending',gasSpent:'0'};await save();
      const wallet=createWalletClient({account,chain:bsc,transport:http(process.env.BSC_RPC_URL??'https://bsc-dataseed.binance.org')});
      job.txHash=await wallet.writeContract({address:vault,abi,functionName:name,args,gas:gasWithMargin,gasPrice});
      job.phase='submitted';await save();
    }
    if(job.phase==='submitted'){
      const receipt=await client.waitForTransactionReceipt({hash:job.txHash});
      job.gasSpent=(receipt.gasUsed*receipt.effectiveGasPrice).toString();
      job.phase=receipt.status==='success'?'complete':'reverted';await save();
    }
    if(job.phase!=='complete')throw new Error(`Keeper transaction ${job.phase}: ${job.txHash}`);
    return job;
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    'approved-create':{type:'boolean'},execute:{type:'boolean'},vault:{type:'string'},owner:{type:'string'},amount:{type:'string'},cap:{type:'string'},round:{type:'string'},action:{type:'string'},'max-gas':{type:'string'},
  }});
  try {
    if(positionals[0]==='create') {
      if(!values['approved-create'])throw new Error('Requires explicit user approval for a new Keychain signing identity');
      console.log(json({operator:await initializeOperator(),storage:'macOS Keychain',service:SERVICE}));
    } else if(positionals[0]==='address') {
      console.log(json({operator:(await signer()).address}));
    } else if(positionals[0]==='bid') {
      if(!values.execute)throw new Error('No transaction sent: --execute requires a previously approved on-chain policy');
      console.log(json(await runRound({vault:values.vault,owner:values.owner,amount:values.amount,cap:values.cap,roundId:values.round,maxGas:values['max-gas']})));
    } else if(positionals[0]==='keeper') {
      if(!values.execute)throw new Error('Keeper execution requires an approved policy and --execute');
      console.log(json(await runKeeper({vault:values.vault,owner:values.owner,action:values.action,roundId:values.round,maxGas:values['max-gas']})));
    } else throw new Error('Use create --approved-create, address, or bid --execute --vault --owner --amount --cap');
  } catch(error) {
    console.error(error.shortMessage??error.message);process.exitCode=1;
  }
}
