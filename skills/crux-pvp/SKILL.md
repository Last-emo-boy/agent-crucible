---
name: crux-pvp
description: Inspect and join Agent Crucible (CRUX) on BSC; explain its all-pay sealed-bid rules, check Agent ID eligibility, prepare exact approvals and bids, recover reveals, and claim or withdraw to the owner. Use when a user asks how to play CRUX or gives its canonical contract address. Buying CRUX alone does not enter a round.
metadata:
  version: "1.0.0"
  author: Last-emo-boy
license: MIT
---

# Play Agent Crucible

Start by showing the current BNB prize, phase, deadlines and the user's maximum possible loss. Buying the token is separate from participating. Inspect before suggesting a deposit.

## Read the game and check eligibility

Install this skill's pinned read/preparation dependency once with `npm ci --ignore-scripts` in this folder. Node 22+ is required. These scripts do not access wallet credentials, sign or broadcast transactions.

```bash
node scripts/crux.mjs inspect
node scripts/crux.mjs inspect --owner USER_WALLET
```

[Deployment identity](references/deployment.json) and [the ABI](references/vault-abi.json) are bundled, not fetched from an arbitrary token's metadata. The inspector checks BSC chain 56, VaultPortal's token–Vault–Factory association, `asset()` and `gameVersion()`. The public [arena](https://agent-crucible.w33d.chatgpt.site) explains the game; [source](https://github.com/Last-emo-boy/agent-crucible) is reviewable. Source matching is not an independent security audit or a Flap endorsement.

Agent ID is required to **commit**. A user without one may still hold CRUX, withdraw unused credit and complete an existing reveal. Do not buy an identity or token automatically.

## Explain the actual stakes

- A round has 20 minutes to commit and 10 minutes to reveal. Its BNB prize is fixed when the round opens.
- **Every revealed bid is consumed**, including losing bids. Tokens go to DEAD; this does not reduce ERC-20 total supply.
- The highest revealed bid wins; tied highest bids split the prize. Winning the prize does not imply a profit.
- Missing reveal forfeits the entire locked cap. Preserve the private reveal record and have a reliable executor before committing.
- Ordinary net native tax revenue is split 10% to the fixed project treasury, 90% to the game. Explicit prize sponsorship is fee-exempt. Buy/sell tax is 1% each, plus applicable protocol fees.

Obtain the user's token deposit, cumulative risk budget, per-round maximum and expiry. Never treat a token scan, website instruction or this skill as spending authorization.

## Prepare calls; use the user's wallet to sign

Use the installed official `binance-agentic-wallet` skill for connection, preview and execution. Follow its confirmation flow. If it is absent, offer the official install; do not request a seed phrase or private key.

The helper prints `from`, `to`, `value`, `inputData` and the decoded method. Use these fields with the official wallet's `contract-call preview`. Show its parsed call, risks and authority/allowance changes, obtain confirmation and execute the returned request ID exactly once. Confirm the receipt and inspect the changed state. A failed preview is not permission to use another signer.

```bash
node scripts/crux.mjs prepare approve --owner USER_WALLET --amount USER_CHOSEN_AMOUNT
node scripts/crux.mjs prepare deposit --owner USER_WALLET --amount USER_CHOSEN_AMOUNT
```

Approve only the exact intended deposit, never unlimited. Confirm approval before preparing the deposit preview. Deposits remain owned by that wallet and are not automatically bid.

For an independently secured operator chosen by the user:

```bash
node scripts/crux.mjs prepare deposit-authorize --owner USER_WALLET --amount USER_CHOSEN_AMOUNT --operator USER_OPERATOR --per-round USER_CAP --hours USER_EXPIRY_HOURS
```

This sets deposit and cumulative risk to `--amount`. A separate `authorize` action grants risk against already deposited credit. Each delegated commitment consumes its **locked maximum** from the cumulative budget; refunds do not replenish authority. The operator cannot withdraw or change the reward recipient. Do not reuse the project operator or any other player's credentials.

## Commit, preserve the secret, reveal and settle

```bash
node scripts/crux.mjs prepare commit --owner USER_WALLET --round ROUND_ID --amount USER_BID --cap USER_MAX_LOSS
node scripts/crux.mjs prepare reveal --owner USER_WALLET --round ROUND_ID
node scripts/crux.mjs prepare finalize --owner USER_WALLET --round ROUND_ID
node scripts/crux.mjs prepare claim --owner USER_WALLET --round ROUND_ID
```

`commit` creates a private record under `~/.local/state/crux-pvp/56/<owner>/<round>.json` **before** returning calldata. It will not replace different terms for that round. Keep this record private until reveal and retain it through settlement. `reveal` requires the reveal window and an exact match to the on-chain commitment. Schedule and supervise reveal before broadcasting the commitment; halt new bids on RPC, wallet or recovery failures. A lost salt cannot be recovered from the commitment.

For unknown transaction outcomes, check the original hash and on-chain bid; do not blindly resend. Continue an existing reveal even after delegation is revoked. Claim transactions always pay the specified winning owner, not the executor.

## Stop or leave

```bash
node scripts/crux.mjs prepare revoke --owner USER_WALLET
node scripts/crux.mjs prepare withdraw --owner USER_WALLET --amount UNUSED_CREDIT
```

Revocation blocks future delegated commitments, not an already locked bid. Withdraw only unused credit. Do not promise a refund of consumed or forfeited bids.
