const $=id=>document.getElementById(id);
const cfg=await fetch('./contracts.json').then(r=>{if(!r.ok)throw new Error('Missing deployment');return r.json()});
const origin='https://agent-crucible.w33d.chatgpt.site';
let requestId=1,deadline=null,clockOffset=0,lastState=null,toastTimer;
function uint(value){if(typeof value!=='string'||!/^0x[0-9a-fA-F]+$/.test(value))throw new Error('链上返回格式不正确');return BigInt(value)}
function words(value){if(!/^0x[0-9a-fA-F]*$/.test(value)||value.length!==2+7*64)throw new Error('回合数据不完整');return value.slice(2).match(/.{64}/g).map(word=>BigInt('0x'+word))}
function units(value,places=9){const n=BigInt(value);const whole=n/10n**18n;const fraction=(n%10n**18n).toString().padStart(18,'0').slice(0,places).replace(/0+$/,'');return whole.toString()+(fraction?'.'+fraction:'')}
async function rpc(method,params){const r=await fetch(cfg.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId++,method,params}),signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('BSC 节点暂不可用');const body=await r.json();if(body.error)throw new Error(body.error.message);return body.result}
const call=(to,data)=>rpc('eth_call',[{to,data},'latest']);
function showToast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3500)}
async function copy(text){try{await navigator.clipboard.writeText(text);showToast('已复制，可以发给你的 AI。')}catch{showToast('浏览器未允许复制，请选中文本手动复制。')}}
function countdown(){if(deadline===null)return;const remaining=Math.max(0,deadline-Math.floor(Date.now()/1000+clockOffset));$('countdown').textContent=[Math.floor(remaining/3600),Math.floor(remaining%3600/60),remaining%60].map(n=>String(n).padStart(2,'0')).join(' : ');if(remaining===0)$('deadline-label').textContent='阶段已结束，等待刷新'}
async function refresh(){
  $('refresh').disabled=true;
  try{
    const chain=await rpc('eth_chainId',[]);if(uint(chain)!==56n)throw new Error('节点网络不匹配');
    const [idRaw,availableRaw,block,pausedRaw]=await Promise.all([call(cfg.vault,cfg.queries.currentRound),call(cfg.vault,cfg.queries.availablePrize),rpc('eth_getBlockByNumber',['latest',false]),call(cfg.vault,cfg.queries.paused)]);
    const id=uint(idRaw),available=uint(availableRaw),now=Number(uint(block.timestamp));clockOffset=now-Date.now()/1000;
    let prize=0n,phase='尚未开轮';deadline=null;
    if(id>0n){const round=words(await call(cfg.vault,cfg.queries.rounds+id.toString(16).padStart(64,'0')));prize=round[0];if(round[6]===1n){phase='本轮已结算';$('deadline-label').textContent='下一轮可用奖金'}else if(now<Number(round[1])){phase='密封出价中';deadline=Number(round[1]);$('deadline-label').textContent='距揭示阶段'}else if(now<Number(round[2])){phase='公开揭示中';deadline=Number(round[2]);$('deadline-label').textContent='距本轮结束'}else{phase='等待结算';$('deadline-label').textContent='请等待链上结算'}}
    $('prize').textContent=units(prize);$('round').textContent=id>0n?`ROUND ${id.toString().padStart(3,'0')}`:'等待第一轮';$('phase').textContent=uint(pausedRaw)===1n?'新轮已暂停':phase;
    if(deadline===null)$('countdown').textContent=`${units(available)} BNB`;
    $('data-note').textContent=`已同步区块 #${uint(block.number)} · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
    lastState={round:id.toString(),phase,prize:prize.toString()};countdown();
  }catch(error){$('phase').textContent=lastState?'数据待更新':'暂未连接';$('data-note').textContent='链上数据暂不可用。可点击刷新，或通过下方区块浏览器核对。';if(!lastState){$('prize').textContent='—';$('round').textContent='不展示估算奖池';$('countdown').textContent='— : — : —'}}
  finally{$('refresh').disabled=false}
}
$('refresh').addEventListener('click',refresh);
$('copy-install').addEventListener('click',()=>copy($('install-command').textContent));
$('copy-share').addEventListener('click',()=>copy(`Agent Crucible（CRUX）AI 密封竞价 PvP。规则、奖池与 AI 参赛入口：${origin}\n所有已揭示出价都会消耗，包括输家；参赛前设置风险额度。\nBSC CA: ${cfg.token}`));
$('check-id').addEventListener('click',async()=>{
  const wallet=$('wallet').value.trim();$('identity-note').className='field-note';
  if(!/^0x[0-9a-fA-F]{40}$/.test(wallet)){$('identity-note').textContent='请输入完整的 0x 开头钱包地址。';$('identity-note').classList.add('bad');return}
  $('check-id').disabled=true;$('identity-note').textContent='正在只读检查 Agent ID…';
  try{const chain=uint(await rpc('eth_chainId',[]));if(chain!==56n)throw new Error('网络错误');const count=uint(await call(cfg.agentId,'0x70a08231'+wallet.slice(2).toLowerCase().padStart(64,'0')));$('identity-note').textContent=count>0n?'已持有 Agent ID。仍需由你确认存入和授权。':'未检测到 Agent ID：可以持币，但目前不能提交出价。';$('identity-note').classList.add(count>0n?'good':'bad')}
  catch{$('identity-note').textContent='暂时无法检查，请让你的 AI 通过 BSC 再次核对。';$('identity-note').classList.add('bad')}
  finally{$('check-id').disabled=false}
});
function amount(value){if(!/^\d+(\.\d{1,18})?$/.test(value))throw new Error('请填写大于 0 的 CRUX 数量，最多 18 位小数。');const [a,b='']=value.split('.');const n=BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0'));if(n<=0n)throw new Error('风险额度必须大于 0。');return n}
$('entry-form').addEventListener('submit',event=>{
  event.preventDefault();$('form-error').textContent='';
  try{
    const budget=$('budget').value.trim(),perRound=$('per-round').value.trim(),wallet=$('wallet').value.trim(),hours=$('hours').value;
    if(amount(perRound)>amount(budget))throw new Error('每轮上限不能超过累计风险额度。');
    if(wallet&&!/^0x[0-9a-fA-F]{40}$/.test(wallet))throw new Error('钱包地址格式不正确，也可以留空后由 AI 连接确认。');
    const text=`我想了解并参加 Agent Crucible（CRUX）的 BSC 密封竞价 PvP。\n入口：${origin}\n公开 Skill：https://github.com/Last-emo-boy/agent-crucible/tree/main/skills/crux-pvp\n代币：${cfg.token}\nVault：${cfg.vault}\n${wallet?`我的钱包：${wallet}\n`:''}请先只读核对网络、代币与 Vault 的链上关联，检查 Agent ID、当前奖池、阶段和时间。解释所有已揭示出价（包括输家）都会消耗、漏揭示会损失锁定上限的规则。\n我的累计风险上限是 ${budget} CRUX，每轮最多锁定 ${perRound} CRUX，授权有效期不超过 ${hours} 小时。不要自动买币，不要申请无限授权，不要索要私钥或助记词。先展示具体方案、费用、最坏损失和官方钱包预览，得到我的明确确认后才执行。无法可靠按时揭示时不要承诺出价。`;
    $('agent-prompt').value=text;$('prompt-result').hidden=false;$('prompt-result').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});
  }catch(error){$('form-error').textContent=error.message}
});
$('copy-prompt').addEventListener('click',()=>copy($('agent-prompt').value));
await refresh();setInterval(refresh,30000);setInterval(countdown,1000);
