/** Choose an all-pay bid using executable token costs and observed rival maxima.
 * Costs are native-currency integers, including transfer tax and gas. No token
 * spot-price multiplication and no invented quote fallback are accepted.
 */
export function chooseBid({candidates,rivalMaxima,prize,minProfit=0n}) {
  if(typeof prize!=='bigint' || prize<=0n)throw new Error('Positive bigint prize required');
  if(!Array.isArray(rivalMaxima) || rivalMaxima.length===0)return {action:'wait',reason:'No opponent sample; do not invent a win probability'};
  let best;
  const count=BigInt(rivalMaxima.length);
  for(const candidate of candidates) {
    if(typeof candidate.amount!=='bigint' || candidate.amount<=0n || typeof candidate.totalCost!=='bigint' || candidate.totalCost<0n)throw new Error('Invalid executable quote');
    // Ties are not optimistically counted as wins: actual tie payout depends on
    // all tied accounts. This intentionally provides a conservative estimate.
    const wins=BigInt(rivalMaxima.filter(x=>candidate.amount>x).length);
    const expected=(prize*wins)/count-candidate.totalCost;
    if(expected>minProfit && (!best || expected>best.expectedProfit))best={...candidate,expectedProfit:expected};
  }
  return best?{action:'commit',...best}:{action:'wait',reason:'No quoted bid clears the profit threshold'};
}
