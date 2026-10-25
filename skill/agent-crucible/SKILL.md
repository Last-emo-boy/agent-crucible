---
name: agent-crucible
description: Discover and operate Agent Crucible CRUX sealed-bid PvP vaults on BSC, including bounded agent authorization, bid preparation, reveal recovery, and reward claims.
---

# Agent Crucible

Use [the BSC deployment manifest](../../deployment/bsc.json) for the canonical token and factory. Names and `gameVersion()` alone do not establish identity.

## Discover

Run the original Binance `meme-rush` skill with chain `56`, protocol `[2002]`, and the appropriate stage (`10` new, `20` finalizing, `30` migrated). Match the full token address. Missing from a capped feed does not prove a token is absent from the index.

Use `node scripts/discover.mjs --token <CA> --factory <factory>` from this project's installed checkout. The live Flap V6 feed can put the **factory** in `taxRateVaultAddress`; this is not a payment destination. Resolve the actual Vault with `VaultPortal.tryGetVault`, verify that the reported address matches either that Vault or its factory, then check the game version and asset. Do not replace Binance's scanner with a local list.

## Understand the cost before committing

This is an all-pay auction: ALL revealed bids are irreversibly sent to DEAD, including losing bids. The highest bid wins the fixed BNB pot; equal highest bids split it. An unrevealed bid loses its entire locked maximum. DEAD transfers do not claim to reduce ERC-20 total supply.

The vault reserves 10% of ordinary native tax receipts for its fixed project treasury; explicit `fundPrize()` sponsorship is exempt. A round locks 80% of the remaining available game balance. Unclaimed rewards cannot fund another round. Quote the current pot, deadlines, token cost, transaction costs, and worst-case loss. Never imply a win or profit is guaranteed.

## Authorize once, within a budget

Use the official Binance Agentic Wallet skill for the owner's login, token approval, deposit, and `authorizeAgent`. Follow its preview and explicit confirmation rules. Do not request a seed phrase or private key.

The owner can authorize an independent operator for a named address, cumulative risk budget, per-round cap, and expiry. `commitBidFor` consumes the full maximum from that risk budget; unused refunds do not silently replenish authority. The operator cannot withdraw or redirect owner funds. Existing reveals remain possible after revocation.

Creating an operator in macOS Keychain is a separate, explicit user decision. `scripts/operator.mjs create --approved-create` never prints the signing secret. The signing identity only needs a small, approved gas balance, never custody of the owner's CRUX.

## Execute and preserve the reveal

Run `node scripts/arena-status.mjs` to inspect the actual policy, prize, phase, past rival winning bids and durable operator jobs. `operatorProcessRunning: true` means another job owns the signer; do not start a second process. All operator sends share a process lock and the total recorded operator gas ceiling is 0.001 BNB.

Within the approved policy window, `node scripts/operator.mjs keeper --execute --vault <vault> --owner <owner> --action start` opens a funded round, and `--action finalize --round <id>` settles an expired round. These methods cannot transfer tokens or change the prize recipient. Do not keep opening unfunded rounds or renew an expired policy.

After the AI chooses a quoted bid inside the approved policy, `node scripts/operator.mjs bid --execute --vault <vault> --owner <owner> --amount <human token amount> --cap <human maximum>` locks, commits, waits, reveals and claims one round. Keep that process running until reveal is confirmed. Its private job record must be retained until completion.

If a job records `sending:*` or `submitted:*`, inspect the recorded hash, account nonce and on-chain commitment before resuming; never replay an ambiguous write. A lost salt cannot be recovered from the commitment. Stop new commitments on RPC, budget or policy failures; prioritize recovery of an already committed reveal.

Use the contract's fixed-recipient `claimReward(round, owner)` and `withdraw(amount)` rather than arbitrary recipient transfers. Report confirmed receipts, not submitted transactions, as completed actions.
