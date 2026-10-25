// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultBaseV3} from "./flap/VaultBaseV3.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor, ApproveAction} from "./flap/IVaultSchemasV1.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/utils/Strings.sol";

/// @notice Native-BNB prize vault. All revealed bids pay; only highest bidders win.
/// @dev A dead-address transfer removes bid tokens from circulation; it does not
///      claim to reduce the underlying token's totalSupply(). No upgrade or sweep.
contract CrucibleVault is VaultBaseV3, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant PRIZE_BPS = 8_000;
    uint256 public constant OPERATIONS_BPS = 1_000;
    string public constant GAME_VERSION = "agent-crucible/1";

    address public immutable taxToken;
    address public immutable agentIdRegistry;
    address public immutable controller;
    uint256 public immutable minPrize;
    uint256 public immutable commitDuration;
    uint256 public immutable revealDuration;

    struct Round {
        uint256 prize;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 highestBid;
        uint256 winnerCount;
        uint256 rewardPerWinner;
        bool finalized;
    }

    struct Bid {
        bytes32 commitment;
        uint256 maxBid;
        uint256 amount;
        bool resolved;
        bool claimed;
    }

    struct Policy {
        address operator;
        uint256 remainingRiskBudget;
        uint256 maxPerRound;
        uint256 validUntil;
    }

    uint256 public currentRound;
    uint256 public reservedRewards;
    uint256 public operationsAccrued;
    uint256 public accountedNative;
    uint256 public totalTokenLiability;
    uint256 public totalTokensConsumed;
    bool public paused;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(address => uint256) public credits;
    mapping(address => Policy) public policies;

    error InvalidConfig();
    error WrongPhase();
    error InvalidBid();
    error InsufficientFunds();
    error Unauthorized();
    error AgentIdRequired();
    error TransferFailed();
    error UnsupportedTransfer();

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event PolicySet(
        address indexed account, address indexed operator, uint256 riskBudget, uint256 perRound, uint256 expiry
    );
    event RoundStarted(uint256 indexed roundId, uint256 prize, uint256 commitEnd, uint256 revealEnd);
    event BidCommitted(uint256 indexed roundId, address indexed account, bytes32 commitment, uint256 maxBid);
    event BidRevealed(uint256 indexed roundId, address indexed account, uint256 amount);
    event BidForfeited(uint256 indexed roundId, address indexed account, uint256 amount);
    event RoundFinalized(uint256 indexed roundId, uint256 highestBid, uint256 winners, uint256 rewardPerWinner);
    event RewardClaimed(uint256 indexed roundId, address indexed account, uint256 amount);
    event Paused(bool paused);
    event RevenueReceived(address indexed sender, uint256 amount);
    event OperationsClaimed(address indexed treasury, uint256 amount);
    event PrizeFunded(address indexed sender, uint256 amount);

    constructor(
        address token_,
        address registry_,
        address controller_,
        uint256 minPrize_,
        uint256 commit_,
        uint256 reveal_
    ) {
        if (
            token_ == address(0) || registry_.code.length == 0 || controller_ == address(0) || minPrize_ == 0
                || commit_ < 60 || reveal_ < 60 || commit_ + reveal_ > 1 days
        ) revert InvalidConfig();
        // VaultPortal creates the token AFTER this vault; token_.code may be empty.
        taxToken = token_;
        agentIdRegistry = registry_;
        controller = controller_;
        minPrize = minPrize_;
        commitDuration = commit_;
        revealDuration = reveal_;
    }

    receive() external payable {
        _syncRevenue();
        emit RevenueReceived(msg.sender, msg.value);
    }

    function syncRevenue() external {
        _syncRevenue();
    }

    function _syncRevenue() internal {
        uint256 balance = address(this).balance;
        _recognizeRevenue(balance);
    }

    function _recognizeRevenue(uint256 balance) internal {
        if (balance > accountedNative) {
            operationsAccrued += (balance - accountedNative) * OPERATIONS_BPS / 10_000;
            accountedNative = balance;
        }
    }

    /// @notice Explicit prize sponsorship is not trading revenue and pays no
    ///         project fee. Flap's ordinary native tax transfers use receive().
    function fundPrize() external payable {
        _recognizeRevenue(address(this).balance - msg.value);
        accountedNative = address(this).balance;
        emit PrizeFunded(msg.sender, msg.value);
    }

    function vaultQuoteToken() public pure override returns (address) {
        return address(0);
    }

    function gameVersion() external pure returns (string memory) {
        return GAME_VERSION;
    }

    function asset() external view returns (address) {
        return taxToken;
    }

    function availablePrize() public view returns (uint256) {
        uint256 balance = address(this).balance;
        uint256 pendingFee = balance > accountedNative ? (balance - accountedNative) * OPERATIONS_BPS / 10_000 : 0;
        return balance - reservedRewards - operationsAccrued - pendingFee;
    }

    /// @notice Fixed 10% of recognized native revenue, never player tokens or
    ///         reserved prizes. Anyone can trigger payment to the fixed treasury.
    function claimOperations() external nonReentrant {
        _syncRevenue();
        uint256 amount = operationsAccrued;
        if (amount == 0) revert InsufficientFunds();
        operationsAccrued = 0;
        accountedNative -= amount;
        emit OperationsClaimed(controller, amount);
        (bool ok,) = controller.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Controller and Flap Guardian may only stop NEW rounds. Existing
    ///         commitments, reveals, claims and withdrawals remain available.
    function setPaused(bool value) external {
        if (msg.sender != controller && msg.sender != _getGuardian()) revert Unauthorized();
        paused = value;
        emit Paused(value);
    }

    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, amount);
    }

    function depositAndAuthorize(uint256 amount, address operator, uint256 riskBudget, uint256 perRound, uint256 expiry)
        external
        nonReentrant
    {
        _deposit(msg.sender, amount);
        _setPolicy(msg.sender, operator, riskBudget, perRound, expiry);
    }

    function _deposit(address account, uint256 amount) internal {
        if (amount == 0) revert InvalidConfig();
        IERC20 token = IERC20(taxToken);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(account, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTransfer();
        credits[account] += amount;
        totalTokenLiability += amount;
        emit Deposited(account, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > credits[msg.sender]) revert InsufficientFunds();
        credits[msg.sender] -= amount;
        totalTokenLiability -= amount;
        IERC20(taxToken).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Budget counts maximum risk committed, not just eventual bids.
    ///         Refunds do not silently replenish delegated spending authority.
    function authorizeAgent(address operator, uint256 riskBudget, uint256 perRound, uint256 expiry) external {
        _setPolicy(msg.sender, operator, riskBudget, perRound, expiry);
    }

    function _setPolicy(address account, address operator, uint256 riskBudget, uint256 perRound, uint256 expiry)
        internal
    {
        if (
            operator == address(0) || riskBudget == 0 || perRound == 0 || perRound > riskBudget
                || expiry <= block.timestamp || expiry > block.timestamp + 30 days
        ) revert InvalidConfig();
        policies[account] = Policy(operator, riskBudget, perRound, expiry);
        emit PolicySet(account, operator, riskBudget, perRound, expiry);
    }

    function revokeAgent() external {
        delete policies[msg.sender];
        emit PolicySet(msg.sender, address(0), 0, 0, 0);
    }

    function startRound() external returns (uint256 id) {
        if (paused || (currentRound != 0 && !rounds[currentRound].finalized)) revert WrongPhase();
        _syncRevenue();
        uint256 prize = availablePrize() * PRIZE_BPS / 10_000;
        if (prize < minPrize) revert InsufficientFunds();
        id = ++currentRound;
        Round storage round = rounds[id];
        round.prize = prize;
        round.commitEnd = block.timestamp + commitDuration;
        round.revealEnd = round.commitEnd + revealDuration;
        reservedRewards += prize;
        emit RoundStarted(id, prize, round.commitEnd, round.revealEnd);
    }

    function bidCommitment(uint256 id, address account, uint256 amount, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, account, amount, salt));
    }

    function commitBid(uint256 id, bytes32 commitment, uint256 maxBid) external {
        _commit(id, msg.sender, commitment, maxBid);
    }

    function commitBidFor(uint256 id, address account, bytes32 commitment, uint256 maxBid) external {
        Policy storage policy = policies[account];
        if (
            msg.sender != policy.operator || block.timestamp >= policy.validUntil || maxBid > policy.maxPerRound
                || maxBid > policy.remainingRiskBudget
        ) revert Unauthorized();
        policy.remainingRiskBudget -= maxBid;
        _commit(id, account, commitment, maxBid);
    }

    function _commit(uint256 id, address account, bytes32 commitment, uint256 maxBid) internal {
        Round storage round = rounds[id];
        if (id == 0 || id != currentRound || round.finalized || block.timestamp >= round.commitEnd) {
            revert WrongPhase();
        }
        if (commitment == bytes32(0) || maxBid == 0 || bids[id][account].commitment != bytes32(0)) revert InvalidBid();
        if (IERC721(agentIdRegistry).balanceOf(account) == 0) revert AgentIdRequired();
        if (credits[account] < maxBid) revert InsufficientFunds();
        credits[account] -= maxBid;
        bids[id][account] = Bid(commitment, maxBid, 0, false, false);
        emit BidCommitted(id, account, commitment, maxBid);
    }

    /// @notice Anyone with the committed preimage may reveal, even after the
    ///         operator is revoked or the identity changes. Funds stay owner's.
    function revealBid(uint256 id, address account, uint256 amount, bytes32 salt) external nonReentrant {
        Round storage round = rounds[id];
        if (id == 0 || block.timestamp < round.commitEnd || block.timestamp >= round.revealEnd || round.finalized) {
            revert WrongPhase();
        }
        Bid storage bid = bids[id][account];
        if (
            bid.resolved || amount == 0 || amount > bid.maxBid
                || bid.commitment != bidCommitment(id, account, amount, salt)
        ) revert InvalidBid();
        bid.resolved = true;
        bid.amount = amount;
        credits[account] += bid.maxBid - amount;
        _consume(amount);
        if (amount > round.highestBid) {
            round.highestBid = amount;
            round.winnerCount = 1;
        } else if (amount == round.highestBid) {
            round.winnerCount += 1;
        }
        emit BidRevealed(id, account, amount);
    }

    /// @notice Lazy, constant-cost forfeiture; no unbounded participant loops.
    function forfeitBid(uint256 id, address account) external nonReentrant {
        Round storage round = rounds[id];
        if (id == 0 || round.revealEnd == 0 || block.timestamp < round.revealEnd) revert WrongPhase();
        Bid storage bid = bids[id][account];
        if (bid.commitment == bytes32(0) || bid.resolved) revert InvalidBid();
        bid.resolved = true;
        _consume(bid.maxBid);
        emit BidForfeited(id, account, bid.maxBid);
    }

    function _consume(uint256 amount) internal {
        totalTokenLiability -= amount;
        totalTokensConsumed += amount;
        IERC20(taxToken).safeTransfer(DEAD, amount);
    }

    function finalizeRound(uint256 id) external {
        Round storage round = rounds[id];
        if (id == 0 || round.revealEnd == 0 || block.timestamp < round.revealEnd || round.finalized) {
            revert WrongPhase();
        }
        round.finalized = true;
        uint256 allocated = 0;
        if (round.winnerCount != 0) {
            round.rewardPerWinner = round.prize / round.winnerCount;
            allocated = round.rewardPerWinner * round.winnerCount;
        }
        reservedRewards -= round.prize - allocated;
        emit RoundFinalized(id, round.highestBid, round.winnerCount, round.rewardPerWinner);
    }

    function claimable(uint256 id, address account) public view returns (uint256) {
        Round storage round = rounds[id];
        Bid storage bid = bids[id][account];
        return round.finalized && bid.resolved && !bid.claimed && bid.amount > 0 && bid.amount == round.highestBid
            ? round.rewardPerWinner
            : 0;
    }

    /// @notice Callable by any keeper; payout address cannot be redirected.
    function claimReward(uint256 id, address account) external nonReentrant {
        _syncRevenue();
        uint256 reward = claimable(id, account);
        if (reward == 0) revert InvalidBid();
        bids[id][account].claimed = true;
        reservedRewards -= reward;
        accountedNative -= reward;
        emit RewardClaimed(id, account, reward);
        (bool ok,) = account.call{value: reward}("");
        if (!ok) revert TransferFailed();
    }

    function description() public view override returns (string memory) {
        return string.concat(
            "Agent Crucible: 10% of native revenue to fixed project treasury, 90% to game. All-pay sealed bids: revealed tokens go to DEAD; highest bids split BNB. ",
            "Missing reveal forfeits the full locked cap. Round ",
            Strings.toString(currentRound),
            paused ? ". New rounds paused; existing bids and withdrawals remain available." : ". New rounds enabled."
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "AgentCrucibleV1";
        schema.description =
            "All-pay auction: all revealed bids are consumed, including losing bids. Missing reveal loses the locked maximum. No guaranteed profit.";
        schema.methods = new VaultMethodSchema[](18);
        schema.methods[0] = _method("availablePrize", "Unreserved BNB; 80% funds the next round", false, 0, 1);
        schema.methods[0].outputs[0] = _field("amount", "uint256", 18);
        schema.methods[1] = _method("currentRound", "Current round ID", false, 0, 1);
        schema.methods[1].outputs[0] = _field("id", "uint256", 0);
        schema.methods[2] = _method("credits", "Withdrawable token credit for account", false, 1, 1);
        schema.methods[2].inputs[0] = _field("account", "address", 0);
        schema.methods[2].outputs[0] = _field("amount", "uint256", 18);
        schema.methods[3] = _method("claimable", "Claimable BNB reward", false, 2, 1);
        schema.methods[3].inputs[0] = _field("id", "uint256", 0);
        schema.methods[3].inputs[1] = _field("account", "address", 0);
        schema.methods[3].outputs[0] = _field("amount", "uint256", 18);
        schema.methods[4] = _method("deposit", "Deposit own tokens, exact approval only", true, 1, 0);
        schema.methods[4].inputs[0] = _field("amount", "uint256", 18);
        schema.methods[4].approvals = new ApproveAction[](1);
        schema.methods[4].approvals[0] = ApproveAction("taxToken", "amount");
        schema.methods[5] = _method("withdraw", "Withdraw unused tokens to your own wallet", true, 1, 0);
        schema.methods[5].inputs[0] = _field("amount", "uint256", 18);
        schema.methods[6] = _method(
            "authorizeAgent", "Grant capped, expiring bid authority; risk budget is consumed at commit", true, 4, 0
        );
        schema.methods[6].inputs[0] = _field("operator", "address", 0);
        schema.methods[6].inputs[1] = _field("riskBudget", "uint256", 18);
        schema.methods[6].inputs[2] = _field("perRound", "uint256", 18);
        schema.methods[6].inputs[3] = _field("expiry", "uint256", 0);
        schema.methods[7] =
            _method("revokeAgent", "Revoke new commitments, not existing reveal obligations", true, 0, 0);
        schema.methods[8] = _method("startRound", "Permissionlessly reserve 80% of available BNB", true, 0, 1);
        schema.methods[8].outputs[0] = _field("id", "uint256", 0);
        schema.methods[9] = _method("commitBid", "Lock maxBid; keep bid and salt private and backed up", true, 3, 0);
        schema.methods[9].inputs[0] = _field("id", "uint256", 0);
        schema.methods[9].inputs[1] = _field("commitment", "bytes32", 0);
        schema.methods[9].inputs[2] = _field("maxBid", "uint256", 18);
        schema.methods[10] =
            _method("revealBid", "Reveal after commit deadline; the bid is irreversibly consumed", true, 4, 0);
        schema.methods[10].inputs[0] = _field("id", "uint256", 0);
        schema.methods[10].inputs[1] = _field("account", "address", 0);
        schema.methods[10].inputs[2] = _field("amount", "uint256", 18);
        schema.methods[10].inputs[3] = _field("salt", "bytes32", 0);
        schema.methods[11] =
            _method("forfeitBid", "After reveal expiry, consume the unrevealed bid's locked maximum", true, 2, 0);
        schema.methods[11].inputs[0] = _field("id", "uint256", 0);
        schema.methods[11].inputs[1] = _field("account", "address", 0);
        schema.methods[12] = _method("finalizeRound", "Finalize expired round; no participant loop", true, 1, 0);
        schema.methods[12].inputs[0] = _field("id", "uint256", 0);
        schema.methods[13] = _method("claimReward", "Pay the winner's own address, regardless of caller", true, 2, 0);
        schema.methods[13].inputs[0] = _field("id", "uint256", 0);
        schema.methods[13].inputs[1] = _field("account", "address", 0);
        schema.methods[14] = _method("setPaused", "Controller/Flap Guardian: only stop NEW rounds", true, 1, 0);
        schema.methods[14].inputs[0] = _field("value", "bool", 0);
        schema.methods[15] =
            _method("operationsAccrued", "Project's fixed 10% native-revenue share; separate from prizes", false, 0, 1);
        schema.methods[15].outputs[0] = _field("amount", "uint256", 18);
        schema.methods[16] =
            _method("claimOperations", "Pay accrued project revenue to fixed controller address", true, 0, 0);
        schema.methods[17] = _method("syncRevenue", "Recognize native revenue received without a callback", true, 0, 0);
    }

    function _field(string memory name, string memory kind, uint8 decimals_)
        private
        pure
        returns (FieldDescriptor memory)
    {
        return FieldDescriptor(name, kind, name, decimals_);
    }

    function _method(string memory name, string memory help, bool write, uint256 inputs, uint256 outputs)
        private
        pure
        returns (VaultMethodSchema memory method)
    {
        method.name = name;
        method.description = help;
        method.isWriteMethod = write;
        method.inputs = new FieldDescriptor[](inputs);
        method.outputs = new FieldDescriptor[](outputs);
        method.approvals = new ApproveAction[](0);
    }
}
