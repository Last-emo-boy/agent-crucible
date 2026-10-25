# Agent Crucible · CRUX

**[Open the arena](https://agent-crucible.w33d.chatgpt.site)** · **[Player Skill](skills/crux-pvp/SKILL.md)** · **[Verified deployment](deployment/bsc.json)**

CRUX is an all-pay, sealed-bid PvP arena on BSC. Players use CRUX bids to compete for a fixed BNB prize. Buying CRUX alone does not enter a round.

**Every revealed bid is consumed, including losing bids. Missing reveal forfeits the full locked cap. Winning the prize does not guarantee a profit.** Source verification is not an independent security audit or a Flap endorsement.

## Ask your agent to help you play

Install the self-contained player Skill in a compatible client:

```sh
npx skills add Last-emo-boy/agent-crucible --skill crux-pvp
```

Or give your AI the [arena link](https://agent-crucible.w33d.chatgpt.site) and ask it to read the rules, check Agent ID eligibility, and propose a capped participation plan **before** any deposit or signature. Never provide a private key or seed phrase.

The Skill bundles its deployment and ABI. Its scripts only read chain state and prepare unsigned calldata; signing remains with your own wallet. In the installed skill folder, run `npm ci --ignore-scripts`, then `node scripts/crux.mjs inspect`. Use the official Binance Agentic Wallet Skill for preview, confirmation and execution.

## How a round works

1. An eligible owner deposits a chosen amount of CRUX. Unlocked credit can be withdrawn by that owner.
2. Players commit a hidden bid during a 20-minute window, locking an explicit maximum.
3. During the following 10 minutes, players reveal their bids. Every revealed bid goes to DEAD.
4. The highest bidder wins the fixed BNB prize. Ties split it. Unrevealed bids forfeit their locked maximum.

A delegated operator has a cumulative maximum-risk budget, a per-round cap and an expiry. It cannot withdraw or redirect rewards. Revocation stops new commitments, not an already committed reveal obligation.

Buy/sell tax is 1% each, plus applicable protocol fees. Of ordinary net native tax receipts received by the Vault, 10% accrues to the fixed project treasury and 90% remains for the game. Explicit `fundPrize()` sponsorship is exempt from this split. A new round reserves 80% of the available game balance; unclaimed prizes cannot be reused.

## Verify the identity

| BSC contract | Address |
|---|---|
| CRUX | `0x3EAA9F68a1f0ee7eDFADAb6219438F74438C7777` |
| PvP Vault | `0xD3C756D0fBF68f7409883399a777c7D19a85b4bA` |
| Factory | `0xb7C5Db7c88552F0B2d61d19F05C06839f8de793F` |

The original Binance `meme-rush` feed identified this deployment under Flap (`protocol=2002`). Its `taxRateVaultAddress` currently reports the **factory**, not the receiving Vault. Resolve the Vault through the official VaultPortal's `tryGetVault` and verify the token association. The bundled discovery script does this; never send funds to the feed field by assumption.

- [Flap token and Vault](https://flap.sh/bnb/0x3EAA9F68a1f0ee7eDFADAb6219438F74438C7777/taxinfo)
- [Vault source verification](https://sourcify.dev/server/verify-ui/jobs/8ee474cf-5891-448f-99c3-6d8ae7cf9597)
- [Factory source verification](https://sourcify.dev/server/verify-ui/jobs/44b6a932-d50d-4399-9253-bc77e3339e61)

## Develop or review

The deployed Solidity source is in `src/`. The public player Skill is in `skills/crux-pvp/`. The earlier `skill/agent-crucible/` entry and root operator scripts are project-maintainer tooling; do not reuse the project's operator identity or initial authorization as your own.

```sh
npm ci
forge test
npm run test:tools
```

Solidity uses 0.8.26/Cancun with the optimizer at 200 runs. Vendored Flap interfaces and Forge standard library retain their upstream licences. No signing keys, session credentials or private bid records belong in this repository.
