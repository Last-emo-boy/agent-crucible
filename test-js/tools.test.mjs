import test from 'node:test';
import assert from 'node:assert/strict';
import { findToken,classifyReportedTaxAddress } from '../scripts/discover.mjs';
import { chooseBid } from '../scripts/strategy.mjs';
import { tokenSalt, launchParams } from '../scripts/lib.mjs';

const token='0x1111111111111111111111111111111111117777';
test('discovery identifies exact chain, CA and protocol rather than symbol',()=>{
  const correct={chainId:'56',protocol:2002,contractAddress:token,symbol:'CRUX'};
  const result={success:true,code:'000000',data:[{...correct,chainId:'8453'},{...correct,protocol:2004},{...correct,contractAddress:'0x2222222222222222222222222222222222227777'},correct]};
  assert.equal(findToken(result,token),correct);
  assert.equal(findToken(result,'0x3333333333333333333333333333333333337777'),undefined);
});
test('unsuccessful or truncated feed fails closed',()=>{
  assert.throws(()=>findToken({success:false,code:'000000',data:[]},token));
  assert.throws(()=>findToken({success:true,code:'000000',data:{}},token));
});
test('Flap discovery distinguishes the reported factory from the actual receiving vault',()=>{
  const info={vault:'0x1111111111111111111111111111111111111111',vaultFactory:'0x2222222222222222222222222222222222222222'};
  assert.equal(classifyReportedTaxAddress(info.vault,info),'vault');
  assert.equal(classifyReportedTaxAddress(info.vaultFactory,info),'factory');
  assert.equal(classifyReportedTaxAddress(undefined,info),'not-reported');
  assert.throws(()=>classifyReportedTaxAddress('0x3333333333333333333333333333333333333333',info));
});
test('strategy skips when evidence or a profitable executable bid is absent',()=>{
  assert.equal(chooseBid({candidates:[],rivalMaxima:[],prize:100n}).action,'wait');
  assert.equal(chooseBid({candidates:[{amount:10n,totalCost:100n}],rivalMaxima:[1n],prize:100n}).action,'wait');
});
test('strategy uses costs and competition rather than choosing the largest bid',()=>{
  const selected=chooseBid({prize:100n,rivalMaxima:[1n,2n,3n,4n],candidates:[{amount:3n,totalCost:10n},{amount:5n,totalCost:90n}]});
  assert.equal(selected.amount,3n);
  assert.equal(selected.expectedProfit,40n);
});
test('ties do not manufacture a guaranteed full-pot payout',()=>{
  assert.equal(chooseBid({prize:100n,rivalMaxima:[10n],candidates:[{amount:10n,totalCost:1n}]}).action,'wait');
});
test('vanity calculation is deterministic and does not use a wallet key',()=>{
  const one=tokenSalt(token,'unit-test');
  const two=tokenSalt(token,'unit-test');
  assert.deepEqual(one,two);
  assert.ok(one.address.toLowerCase().endsWith('7777'));
});
test('launch uses fixed symmetric taxes and the dedicated native vault',()=>{
  const params=launchParams(token,'0x'+'11'.repeat(32),'bafy-metadata');
  assert.equal(params.tokenVersion,6);
  assert.equal(params.buyTaxRate,100);
  assert.equal(params.sellTaxRate,100);
  assert.equal(params.mktBps,10000);
  assert.equal(params.vaultFactory,token);
  assert.throws(()=>launchParams(token,'0x'+'11'.repeat(32),''));
});
