import test from 'node:test';
import assert from 'node:assert/strict';
import {commitment,operationSatisfied} from '../scripts/operator.mjs';

test('commitments bind chain, vault, round, account, amount and salt',()=>{
  const args=[56,'0x1111111111111111111111111111111111111111',1n,'0x2222222222222222222222222222222222222222',100n,'0x'+'55'.repeat(32)];
  const base=commitment(...args);
  const replacements=[57,'0x3333333333333333333333333333333333333333',2n,'0x4444444444444444444444444444444444444444',101n,'0x'+'66'.repeat(32)];
  for(let i=0;i<args.length;i++){const modified=[...args];modified[i]=replacements[i];assert.notEqual(commitment(...modified),base);}
});

test('reverted keeper transactions only recover after the exact chain postcondition',async()=>{
  const terms={round:1n,owner:'0x2222222222222222222222222222222222222222',digest:'0x'+'55'.repeat(32),maximum:100n,bid:90n};
  let recorded=[terms.digest,100n,90n,true,false];
  let finalized=false;
  const read=async name=>name==='bids'?recorded:[0n,0n,0n,0n,0n,0n,finalized];
  assert.equal(await operationSatisfied(read,'commitBidFor',terms),true);
  assert.equal(await operationSatisfied(read,'revealBid',terms),true);
  assert.equal(await operationSatisfied(read,'claimReward',terms),false);
  assert.equal(await operationSatisfied(read,'finalizeRound',terms),false);
  finalized=true;recorded[4]=true;
  assert.equal(await operationSatisfied(read,'finalizeRound',terms),true);
  assert.equal(await operationSatisfied(read,'claimReward',terms),true);
  recorded[0]='0x'+'66'.repeat(32);
  assert.equal(await operationSatisfied(read,'claimReward',terms),false);
  recorded=[terms.digest,100n,0n,true,false];
  assert.equal(await operationSatisfied(read,'revealBid',terms),false,'forfeiture is not a reveal');
  assert.equal(await operationSatisfied(read,'unknown',terms),false);
});
