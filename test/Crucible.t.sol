// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";
import {CrucibleVault} from "../src/CrucibleVault.sol";
import {CrucibleFactory} from "../src/CrucibleFactory.sol";
import {VaultUISchema} from "../src/flap/IVaultSchemasV1.sol";
import {IVaultFactory, IVaultFactoryValidationV2} from "../src/flap/IVaultFactory.sol";
import {IPortalTypes} from "../src/flap/IPortal.sol";

contract MockToken is ERC20 {
    bool public fee;
    constructor() ERC20("Crucible", "CRUX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(bool value) external {
        fee = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (fee && from != address(0) && to != address(0)) {
            super._update(from, to, value - value / 100);
            super._update(from, address(0), value / 100);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockRegistry {
    mapping(address => uint256) public balanceOf;

    function set(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

contract RejectNative {
    receive() external payable {
        revert("reject");
    }
}

contract CrucibleTest is Test {
    address constant PORTAL = 0x90497450f2a706f1951b5bdda52B4E5d16f34C06;
    address constant GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address operator = makeAddr("operator");
    bytes32 constant SALT = bytes32(uint256(77));
    MockToken token;
    MockRegistry registry;
    CrucibleFactory factory;
    CrucibleVault vault;

    function setUp() public {
        vm.chainId(56);
        token = new MockToken();
        registry = new MockRegistry();
        factory = new CrucibleFactory(address(registry));
        vm.prank(PORTAL);
        vault = CrucibleVault(
            payable(factory.newVault(address(token), address(0), address(this), abi.encode(0.01 ether, 1200, 600)))
        );
        _deposit(alice, 1000 ether);
        _deposit(bob, 1000 ether);
    }

    receive() external payable {}

    function _deposit(address account, uint256 amount) internal {
        registry.set(account, 1);
        token.mint(account, amount);
        vm.startPrank(account);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _fund(uint256 value) internal {
        vm.deal(address(this), value);
        (bool ok,) = address(vault).call{value: value}("");
        assertTrue(ok);
    }

    function _start() internal returns (uint256) {
        _fund(1 ether);
        return vault.startRound();
    }

    function _commit(uint256 id, address account, uint256 amount, uint256 maximum) internal {
        bytes32 commitment = vault.bidCommitment(id, account, amount, SALT);
        vm.prank(account);
        vault.commitBid(id, commitment, maximum);
    }

    function _revealTime(uint256 id) internal {
        (, uint256 end,,,,,) = vault.rounds(id);
        vm.warp(end);
    }

    function _end(uint256 id) internal {
        (,, uint256 end,,,,) = vault.rounds(id);
        vm.warp(end);
        vault.finalizeRound(id);
    }

    function test_AllPayAndWinnerPayout() public {
        uint256 id = _start();
        _commit(id, alice, 100 ether, 300 ether);
        _commit(id, bob, 200 ether, 400 ether);
        _revealTime(id);
        vault.revealBid(id, alice, 100 ether, SALT);
        vault.revealBid(id, bob, 200 ether, SALT);
        assertEq(token.balanceOf(vault.DEAD()), 300 ether);
        assertEq(vault.credits(alice), 900 ether);
        assertEq(vault.credits(bob), 800 ether);
        assertEq(vault.totalTokenLiability(), 1700 ether);
        _end(id);
        assertEq(vault.claimable(id, alice), 0);
        assertEq(vault.claimable(id, bob), 0.72 ether);
        vm.prank(alice); // caller cannot redirect Bob's payment
        vault.claimReward(id, bob);
        assertEq(bob.balance, 0.72 ether);
        assertEq(vault.availablePrize(), 0.18 ether);
        assertEq(vault.reservedRewards(), 0);
        vm.expectRevert(CrucibleVault.InvalidBid.selector);
        vault.claimReward(id, bob);
    }

    function test_TiesShareAndDustReleased() public {
        _fund(1 ether + 2);
        uint256 id = vault.startRound();
        _commit(id, alice, 100 ether, 100 ether);
        _commit(id, bob, 100 ether, 100 ether);
        _revealTime(id);
        vault.revealBid(id, alice, 100 ether, SALT);
        vault.revealBid(id, bob, 100 ether, SALT);
        _end(id);
        assertEq(vault.claimable(id, alice), 0.36 ether);
        assertEq(vault.claimable(id, bob), 0.36 ether);
        assertEq(vault.availablePrize(), 0.18 ether + 2);
    }

    function test_UnrevealedForfeitsMaximumAndEmptyPrizeRolls() public {
        uint256 id = _start();
        _commit(id, alice, 10 ether, 100 ether);
        _end(id);
        assertEq(vault.availablePrize(), 0.9 ether);
        vault.forfeitBid(id, alice);
        assertEq(token.balanceOf(vault.DEAD()), 100 ether);
        assertEq(vault.credits(alice), 900 ether);
        assertEq(vault.totalTokenLiability(), 1900 ether);
        vm.expectRevert(CrucibleVault.InvalidBid.selector);
        vault.forfeitBid(id, alice);
    }

    function test_EmptyRound() public {
        uint256 id = _start();
        _end(id);
        assertEq(vault.reservedRewards(), 0);
        assertEq(vault.availablePrize(), 0.9 ether);
        assertEq(vault.startRound(), 2);
    }

    function test_UnclaimedPrizeNeverReused() public {
        uint256 id = _start();
        _commit(id, alice, 1 ether, 1 ether);
        _revealTime(id);
        vault.revealBid(id, alice, 1 ether, SALT);
        _end(id);
        vault.startRound();
        (uint256 prize,,,,,,) = vault.rounds(2);
        assertEq(prize, 0.144 ether);
        assertEq(vault.reservedRewards(), 0.864 ether);
        vault.claimReward(1, alice);
        assertEq(vault.reservedRewards(), 0.144 ether);
    }

    function test_PolicyBoundsRevocationAndPermissionlessReveal() public {
        uint256 id = _start();
        vm.prank(alice);
        vault.authorizeAgent(operator, 200 ether, 100 ether, block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(CrucibleVault.Unauthorized.selector);
        vault.commitBidFor(id, alice, bytes32(uint256(1)), 101 ether);
        bytes32 commitment = vault.bidCommitment(id, alice, 50 ether, SALT);
        vm.prank(operator);
        vault.commitBidFor(id, alice, commitment, 100 ether);
        (, uint256 remaining,,) = vault.policies(alice);
        assertEq(remaining, 100 ether);
        vm.prank(alice);
        vault.revokeAgent();
        _revealTime(id);
        vm.prank(bob);
        vault.revealBid(id, alice, 50 ether, SALT);
        assertEq(vault.credits(alice), 950 ether);
        _end(id);
        uint256 next = vault.startRound();
        vm.prank(operator);
        vm.expectRevert(CrucibleVault.Unauthorized.selector);
        vault.commitBidFor(next, alice, bytes32(uint256(2)), 1 ether);
    }

    function test_ExpiredPolicy() public {
        uint256 id = _start();
        vm.prank(alice);
        vault.authorizeAgent(operator, 100 ether, 100 ether, block.timestamp + 100);
        vm.warp(block.timestamp + 100);
        vm.prank(operator);
        vm.expectRevert(CrucibleVault.Unauthorized.selector);
        vault.commitBidFor(id, alice, bytes32(uint256(1)), 1 ether);
    }

    function test_PhasesAndReplayProtection() public {
        uint256 id = _start();
        _commit(id, alice, 10 ether, 20 ether);
        vm.expectRevert(CrucibleVault.WrongPhase.selector);
        vault.revealBid(id, alice, 10 ether, SALT);
        vm.expectRevert(CrucibleVault.WrongPhase.selector);
        vault.finalizeRound(id);
        _revealTime(id);
        vm.expectRevert(CrucibleVault.InvalidBid.selector);
        vault.revealBid(id, bob, 10 ether, SALT);
        vm.expectRevert(CrucibleVault.InvalidBid.selector);
        vault.revealBid(id, alice, 11 ether, SALT);
        vault.revealBid(id, alice, 10 ether, SALT);
        vm.expectRevert(CrucibleVault.InvalidBid.selector);
        vault.revealBid(id, alice, 10 ether, SALT);
        _end(id);
        uint256 next = vault.startRound();
        assertNotEq(vault.bidCommitment(id, alice, 10 ether, SALT), vault.bidCommitment(next, alice, 10 ether, SALT));
    }

    function test_PauseOnlyAffectsNewRounds() public {
        uint256 id = _start();
        vault.setPaused(true);
        _commit(id, alice, 10 ether, 20 ether);
        _revealTime(id);
        vault.revealBid(id, alice, 10 ether, SALT);
        _end(id);
        vault.claimReward(id, alice);
        vm.prank(alice);
        vault.withdraw(990 ether);
        vm.expectRevert(CrucibleVault.WrongPhase.selector);
        vault.startRound();
        vm.prank(GUARDIAN);
        vault.setPaused(false);
        vault.startRound();
        vm.prank(bob);
        vm.expectRevert(CrucibleVault.Unauthorized.selector);
        vault.setPaused(true);
    }

    function test_IdentityOnlyRequiredAtCommit() public {
        uint256 id = _start();
        registry.set(alice, 0);
        vm.prank(alice);
        vm.expectRevert(CrucibleVault.AgentIdRequired.selector);
        vault.commitBid(id, bytes32(uint256(1)), 10 ether);
        registry.set(alice, 1);
        _commit(id, alice, 10 ether, 10 ether);
        registry.set(alice, 0);
        _revealTime(id);
        vault.revealBid(id, alice, 10 ether, SALT);
        _end(id);
        vault.claimReward(id, alice);
    }

    function test_LockedFundsCannotBeWithdrawn() public {
        uint256 id = _start();
        _commit(id, alice, 100 ether, 100 ether);
        vm.prank(alice);
        vm.expectRevert(CrucibleVault.InsufficientFunds.selector);
        vault.withdraw(901 ether);
        vm.prank(alice);
        vault.withdraw(900 ether);
        assertEq(vault.totalTokenLiability(), 1100 ether);
        assertEq(token.balanceOf(address(vault)), 1100 ether);
    }

    function test_UnexpectedTransferTaxRejectedAtomically() public {
        token.mint(alice, 100 ether);
        token.setFee(true);
        vm.startPrank(alice);
        token.approve(address(vault), 100 ether);
        vm.expectRevert(CrucibleVault.UnsupportedTransfer.selector);
        vault.deposit(100 ether);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(vault.credits(alice), 1000 ether);
    }

    function test_FailedNativeRecipientDoesNotBlockOtherWinner() public {
        address rejector = address(new RejectNative());
        _deposit(rejector, 100 ether);
        uint256 id = _start();
        _commit(id, rejector, 10 ether, 10 ether);
        _commit(id, alice, 10 ether, 10 ether);
        _revealTime(id);
        vault.revealBid(id, rejector, 10 ether, SALT);
        vault.revealBid(id, alice, 10 ether, SALT);
        _end(id);
        vm.expectRevert(CrucibleVault.TransferFailed.selector);
        vault.claimReward(id, rejector);
        assertEq(vault.claimable(id, rejector), 0.36 ether);
        vault.claimReward(id, alice);
        assertEq(vault.reservedRewards(), 0.36 ether);
    }

    function test_UnsupportedFactoryPathsAndSchemas() public {
        vm.expectRevert(IVaultFactory.OnlyVaultPortal.selector);
        factory.newVault(address(token), address(0), alice, abi.encode(1, 1200, 600));
        vm.prank(PORTAL);
        vm.expectRevert(CrucibleFactory.UnsupportedQuote.selector);
        factory.newVault(address(token), address(token), alice, abi.encode(1, 1200, 600));
        assertEq(factory.factorySpecVersion(), "v2.3");
        assertTrue(factory.isQuoteTokenSupported(address(0)));
        assertFalse(factory.isQuoteTokenSupported(address(token)));
        assertEq(vault.vaultSpecVersion(), "v3");
        VaultUISchema memory schema = vault.vaultUISchema();
        assertEq(schema.vaultType, "AgentCrucibleV1");
        assertEq(schema.methods[4].approvals[0].amountFieldName, "amount");
        IVaultFactoryValidationV2.LaunchValidationDataV1 memory data;
        data.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V3;
        data.buyTaxRate = 100;
        data.sellTaxRate = 100;
        data.vaultBps = 10_000;
        (bool valid,) = factory.onBeforeLaunch(abi.encode(data));
        assertTrue(valid);
        data.buyTaxRate = 200;
        (valid,) = factory.onBeforeLaunch(abi.encode(data));
        assertFalse(valid);
    }

    function testFuzz_TokenConservation(uint128 a, uint128 b) public {
        uint256 amountA = bound(a, 1, 1000 ether);
        uint256 amountB = bound(b, 1, 1000 ether);
        uint256 id = _start();
        _commit(id, alice, amountA, 1000 ether);
        _commit(id, bob, amountB, 1000 ether);
        _revealTime(id);
        vault.revealBid(id, alice, amountA, SALT);
        vault.revealBid(id, bob, amountB, SALT);
        assertEq(token.balanceOf(address(vault)), vault.totalTokenLiability());
        assertEq(vault.totalTokenLiability() + token.balanceOf(vault.DEAD()), 2000 ether);
        _end(id);
        if (amountA >= amountB) vault.claimReward(id, alice);
        if (amountB >= amountA) vault.claimReward(id, bob);
        assertEq(address(vault).balance + alice.balance + bob.balance, 1 ether);
        assertEq(vault.reservedRewards(), 0);
    }

    function test_OperationsCannotTouchPrizeOrChargeRevenueTwice() public {
        uint256 id = _start();
        assertEq(vault.operationsAccrued(), 0.1 ether);
        assertEq(vault.reservedRewards(), 0.72 ether);
        vault.syncRevenue();
        assertEq(vault.operationsAccrued(), 0.1 ether);
        uint256 before = address(this).balance;
        vm.prank(bob);
        vault.claimOperations();
        assertEq(address(this).balance - before, 0.1 ether);
        assertEq(vault.availablePrize(), 0.18 ether);
        assertEq(vault.reservedRewards(), 0.72 ether);
        vault.syncRevenue();
        assertEq(vault.operationsAccrued(), 0);
        _end(id);
        assertEq(vault.availablePrize(), 0.9 ether);
        assertEq(vault.accountedNative(), address(vault).balance);
    }

    function test_ExplicitPrizeSeedIsNotProjectRevenue() public {
        vm.deal(address(this), 1 ether);
        vault.fundPrize{value: 1 ether}();
        assertEq(vault.operationsAccrued(), 0);
        assertEq(vault.availablePrize(), 1 ether);
        uint256 id = vault.startRound();
        (uint256 prize,,,,,,) = vault.rounds(id);
        assertEq(prize, 0.8 ether);
    }

    function testFuzz_MultipleRoundsPreserveNativeLiabilities(uint96 funds, uint8 roundsCount) public {
        uint256 initial = bound(funds, 1 ether, 100 ether);
        uint256 count = bound(roundsCount, 1, 8);
        _fund(initial);
        uint256 earned;
        for (uint256 i; i < count; ++i) {
            if (vault.availablePrize() * 8000 / 10000 < 0.01 ether) break;
            uint256 id = vault.startRound();
            if (i % 3 == 0) {
                _end(id); // empty round releases its entire reservation
            } else if (i % 3 == 1) {
                _commit(id, alice, 1 ether, 2 ether);
                _revealTime(id);
                vault.revealBid(id, alice, 1 ether, SALT);
                _end(id);
                earned += vault.claimable(id, alice);
                vault.claimReward(id, alice);
            } else {
                _commit(id, bob, 1 ether, 2 ether);
                _end(id);
                vault.forfeitBid(id, bob);
            }
            assertEq(token.balanceOf(address(vault)), vault.totalTokenLiability());
            assertEq(vault.reservedRewards(), 0);
            assertEq(address(vault).balance + earned, initial);
            assertEq(vault.availablePrize() + vault.operationsAccrued(), address(vault).balance);
        }
        uint256 ops = vault.operationsAccrued();
        vault.claimOperations();
        assertEq(address(vault).balance + earned + ops, initial);
        assertEq(vault.accountedNative(), address(vault).balance);
    }
}
