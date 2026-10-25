import {parseArgs} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseAbi} from 'viem';
import {config,client,read,verifyDeployment,address,tokens,bidHash,transaction,approveTransaction,json} from './client.mjs';

const {positionals,values}=parseArgs({allowPositionals:true,options:{owner:{type:'string'},amount:{type:'string'},cap:{type:'string'},operator:{type:'string'},'per-round':{type:'string'},hours:{type:'string',default:'24'},round:{type:'string'}}});
const command=positionals[0],action=positionals[1];
const verdict=await verifyDeployment();
const now=(await client.getBlock()).timestamp;
const id=values.round?BigInt(values.round):await read('currentRound');
const round=id>0n?await read('rounds',[id]):null;
const owner=values.owner?address(values.owner,'owner'):null;
const identityAbi=parseAbi(['function balanceOf(address) view returns (uint256)']);

if(command==='inspect'){
  const account=owner?{
    address:owner,agentIdCount:await client.readContract({address:config.agentIdRegistry,abi:identityAbi,functionName:'balanceOf',args:[owner]}),
    credits:await read('credits',[owner]),policy:await read('policies',[owner]),bid:id>0n?await read('bids',[id,owner]):null,
    reward:id>0n?await read('claimable',[id,owner]):0n,
  }:null;
  console.log(json({chainId:56,token:config.token,vault:config.vault,deploymentMatched:true,...verdict,now,roundId:id,
    phase:!round?'not-started':round[6]?'settled':now<round[1]?'commit':now<round[2]?'reveal':'settlement-due',
    round:round&&{prize:round[0],commitEnd:round[1],revealEnd:round[2],highestBid:round[3],winnerCount:round[4],rewardPerWinner:round[5],finalized:round[6]},
    availablePrize:await read('availablePrize'),paused:await read('paused'),account}));
}else if(command==='prepare'){
  if(!owner)throw new Error('--owner is required; this script never connects or signs a wallet');
  let request;
  const amountActions=['approve','deposit','withdraw','deposit-authorize','authorize','commit'];
  const amount=amountActions.includes(action)?tokens(values.amount):0n;
  if(action==='approve')request=approveTransaction(owner,amount);
  else if(['deposit','withdraw'].includes(action))request=transaction(owner,action,[amount]);
  else if(['deposit-authorize','authorize'].includes(action)){
    const perRound=tokens(values['per-round']);
    if(perRound>amount)throw new Error('Per-round cap cannot exceed the cumulative risk budget');
    if(!/^\d+$/.test(values.hours)||Number(values.hours)<1||Number(values.hours)>720)throw new Error('Expiry must be from 1 to 720 hours');
    const args=[address(values.operator,'operator'),amount,perRound,now+BigInt(values.hours)*3600n];
    request=transaction(owner,action==='authorize'?'authorizeAgent':'depositAndAuthorize',action==='authorize'?args:[amount,...args]);
  }else if(action==='revoke')request=transaction(owner,'revokeAgent');
  else if(action==='start')request=transaction(owner,'startRound');
  else if(action==='finalize')request=transaction(owner,'finalizeRound',[id]);
  else if(action==='claim')request=transaction(owner,'claimReward',[id,owner]);
  else if(['commit','reveal'].includes(action)){
    if(!round)throw new Error('No round exists');
    const folder=join(homedir(),'.local','state','crux-pvp','56',owner.toLowerCase());
    const file=join(folder,`${id}.json`);
    if(action==='commit'){
      if(round[6]||now+60n>=round[1])throw new Error('Commit window closed or less than 60 seconds remain');
      if(await client.readContract({address:config.agentIdRegistry,abi:identityAbi,functionName:'balanceOf',args:[owner]})===0n)throw new Error('Agent ID required before committing');
      const maximum=values.cap?tokens(values.cap):amount;
      if(amount>maximum||maximum>await read('credits',[owner]))throw new Error('Bid exceeds cap or deposited credit');
      await mkdir(folder,{recursive:true,mode:0o700});
      let job;
      try{job=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(job&&(job.amount!==amount.toString()||job.cap!==maximum.toString()))throw new Error('A different private bid already exists for this round');
      if(!job){job={chainId:56,vault:config.vault,owner,round:id.toString(),amount:amount.toString(),cap:maximum.toString(),salt:`0x${randomBytes(32).toString('hex')}`};await writeFile(file,json(job),{mode:0o600,flag:'wx'});}
      const hash=bidHash(id,owner,amount,job.salt);
      request={...transaction(owner,'commitBid',[id,hash,maximum]),privateRevealRecord:file,commitment:hash,maxLossCRUX:values.cap??values.amount};
    }else{
      if(now<round[1]||now>=round[2]||round[6])throw new Error('Not within the reveal window');
      const job=JSON.parse(await readFile(file,'utf8'));
      const recorded=await read('bids',[id,owner]);
      if(recorded[0]!==bidHash(id,owner,BigInt(job.amount),job.salt)||recorded[1]!==BigInt(job.cap))throw new Error('The private record does not match the on-chain commitment');
      if(recorded[3])throw new Error('Bid already resolved; inspect it instead of replaying');
      request=transaction(owner,'revealBid',[id,owner,BigInt(job.amount),job.salt]);
    }
  }else throw new Error('Unknown action: use approve, deposit, withdraw, authorize, deposit-authorize, revoke, start, commit, reveal, finalize or claim');
  console.log(json({...request,broadcast:false,next:'Review the decoded call, run the official wallet preview, obtain explicit confirmation, then execute that preview once.'}));
}else throw new Error('Use inspect [--owner ADDRESS] or prepare ACTION --owner ADDRESS');
