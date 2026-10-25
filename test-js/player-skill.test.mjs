import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,parseAbi} from 'viem';
import {address,tokens,bidHash,approveTransaction,transaction,config,abi} from '../skills/crux-pvp/scripts/client.mjs';

const owner='0x1111111111111111111111111111111111111111';
test('player amounts are decimal exact and reject zero, exponent notation and excess precision',()=>{
  assert.equal(tokens('1.000000000000000001'),1000000000000000001n);
  for(const value of ['0','-1','1e3','1.0000000000000000001','not a number'])assert.throws(()=>tokens(value));
  assert.throws(()=>address('crux'));
});
test('player approval is exact and bound to the canonical vault, not the factory',()=>{
  const request=approveTransaction(owner,123n);
  const decoded=decodeFunctionData({abi:parseAbi(['function approve(address,uint256) returns (bool)']),data:request.inputData});
  assert.equal(request.to,config.token);assert.equal(request.from,owner);assert.equal(request.value,'0');
  assert.equal(decoded.args[0].toLowerCase(),config.vault.toLowerCase());assert.equal(decoded.args[1],123n);
});
test('withdrawals and claims cannot nominate a different recipient',()=>{
  const withdrawal=decodeFunctionData({abi,data:transaction(owner,'withdraw',[5n]).inputData});
  assert.deepEqual(withdrawal.args,[5n]);
  const claim=decodeFunctionData({abi,data:transaction(owner,'claimReward',[1n,owner]).inputData});
  assert.deepEqual(claim.args,[1n,owner]);
});
test('public and project executors use the same domain-separated commitment',async()=>{
  const {commitment}=await import('../scripts/operator.mjs');
  const salt='0x'+'ab'.repeat(32);
  assert.equal(bidHash(3n,owner,100n,salt),commitment(56,config.vault,3n,owner,100n,salt));
});
