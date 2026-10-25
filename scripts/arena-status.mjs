import {readFile,readdir} from 'node:fs/promises';
import {parseAbi} from 'viem';
import {ROOT,publicClient,artifact,json} from './lib.mjs';

const deployment=JSON.parse(await readFile(new URL('deployment/bsc.json',ROOT)));
const {vault,controller:owner,token}=deployment,client=publicClient();
if(await client.getChainId()!==56)throw new Error('BSC mainnet required');
const abi=(await artifact('CrucibleVault','CrucibleVault')).abi;
const read=(name,args=[])=>client.readContract({address:vault,abi,functionName:name,args});
if((await read('asset')).toLowerCase()!==token.toLowerCase())throw new Error('Wrong vault asset');
const [block,round,policy,credit,available,operations,paused]=await Promise.all([
  client.getBlock(),read('currentRound'),read('policies',[owner]),read('credits',[owner]),read('availablePrize'),read('operationsAccrued'),read('paused'),
]);
const current=round?await read('rounds',[round]):null;
const ownBid=round?await read('bids',[round,owner]):null;
const rivalMaxima=[];
for(let id=round-1n;id>0n&&id>=round-20n;id--){
  const prior=await read('rounds',[id]);
  if(!prior[6]||prior[4]===0n)continue;
  const bid=await read('bids',[id,owner]);
  // Exclude our own winning bid, including ties, from the rival sample.
  if(bid[2]===prior[3])continue;
  rivalMaxima.push({round:id,highestBid:prior[3],winnerCount:prior[4]});
}
const jobs=[];let gasSpent=0n,operatorProcessRunning=false;
for(const file of await readdir(new URL('.secrets/',ROOT))){
  if(!/^(keeper-|0x[\da-f]{40}-0x[\da-f]{40}-\d+\.json$)/.test(file)||!file.endsWith('.json'))continue;
  const job=JSON.parse(await readFile(new URL(`.secrets/${file}`,ROOT)));
  gasSpent+=BigInt(job.gasSpent??0);
  if(job.vault?.toLowerCase()===vault.toLowerCase())jobs.push({file,round:job.round,phase:job.phase,txHash:job.txHash,action:job.action});
}
try{
  const lock=JSON.parse(await readFile(new URL('.secrets/operator.lock',ROOT)));
  try{process.kill(lock.pid,0);operatorProcessRunning=true;}catch(error){if(error.code!=='ESRCH')throw error;}
}catch(error){if(error.code!=='ENOENT')throw error;}
const tokenAbi=parseAbi(['function allowance(address,address) view returns (uint256)']);
const allowance=await client.readContract({address:token,abi:tokenAbi,functionName:'allowance',args:[owner,vault]});
console.log(json({chainId:56,block:block.number,now:block.timestamp,vault,owner,token,paused,
  policy:{operator:policy[0],remainingRiskBudget:policy[1],maxPerRound:policy[2],validUntil:policy[3],active:policy[3]>block.timestamp},
  credit,allowance,operatorBalance:await client.getBalance({address:policy[0]}),operatorGasSpent:gasSpent,operatorProcessRunning,
  availablePrize:available,operationsAccrued:operations,currentRound:round,
  current:current&&{prize:current[0],commitEnd:current[1],revealEnd:current[2],highestBid:current[3],winnerCount:current[4],rewardPerWinner:current[5],finalized:current[6]},
  ownBid:ownBid&&{commitment:ownBid[0],maxBid:ownBid[1],amount:ownBid[2],resolved:ownBid[3],claimed:ownBid[4]},rivalMaxima,jobs}));
