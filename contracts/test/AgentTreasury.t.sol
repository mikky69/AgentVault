// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgentTreasury.sol";
import "./mocks/MockUSDC.sol";

contract AgentTreasuryTest is Test {
    AgentTreasury treasury;
    MockUSDC usdc;

    address owner = address(this);
    address relayer = makeAddr("relayer");
    address agent = makeAddr("agent");
    address funder = makeAddr("funder");

    bytes32 constant PROVIDER_A = keccak256("moove-handle:provider-a");
    bytes32 constant PROVIDER_B = keccak256("moove-handle:provider-b");

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new AgentTreasury(address(usdc), relayer);

        // Fund the "funder" (stands in for the org treasury) and approve.
        usdc.mint(funder, 1_000e6);
        vm.prank(funder);
        usdc.approve(address(treasury), type(uint256).max);

        // Give the agent a policy + one allowed counterparty.
        treasury.setPolicy(agent, 100e6); // 100 USDC/day cap
        treasury.setCounterpartyAllowed(agent, PROVIDER_A, true);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(funder);
        treasury.deposit(agent, amount);
    }

    function test_DepositCreditsAgentBalance() public {
        _deposit(50e6);
        assertEq(treasury.balanceOf(agent), 50e6);
        assertEq(usdc.balanceOf(address(treasury)), 50e6);
    }

    function test_SpendMovesFundsToRelayerAndDecrementsBalance() public {
        _deposit(50e6);

        vm.prank(agent);
        treasury.spend(PROVIDER_A, 10e6, keccak256("req-1"));

        assertEq(treasury.balanceOf(agent), 40e6);
        assertEq(usdc.balanceOf(relayer), 10e6);
    }

    function test_RevertWhen_CounterpartyNotAllowed() public {
        _deposit(50e6);

        vm.prank(agent);
        vm.expectRevert(AgentTreasury.CounterpartyNotAllowed.selector);
        treasury.spend(PROVIDER_B, 10e6, keccak256("req-1"));
    }

    function test_RevertWhen_DailyCapExceeded() public {
        _deposit(500e6); // plenty of balance, cap is the constraint

        vm.startPrank(agent);
        treasury.spend(PROVIDER_A, 60e6, keccak256("req-1"));

        vm.expectRevert(AgentTreasury.DailyCapExceeded.selector);
        treasury.spend(PROVIDER_A, 60e6, keccak256("req-2")); // 60+60 > 100 cap
        vm.stopPrank();
    }

    function test_RevertWhen_InsufficientBalance() public {
        _deposit(5e6);

        vm.prank(agent);
        vm.expectRevert(AgentTreasury.InsufficientBalance.selector);
        treasury.spend(PROVIDER_A, 10e6, keccak256("req-1"));
    }

    function test_RevertWhen_RequestIdReused() public {
        _deposit(50e6);
        bytes32 reqId = keccak256("req-1");

        vm.startPrank(agent);
        treasury.spend(PROVIDER_A, 10e6, reqId);

        vm.expectRevert(AgentTreasury.RequestIdAlreadyUsed.selector);
        treasury.spend(PROVIDER_A, 10e6, reqId);
        vm.stopPrank();
    }

    function test_RevertWhen_NoPolicySetForAgent() public {
        address strangerAgent = makeAddr("strangerAgent");
        _deposit(50e6); // deposits go to `agent`, not strangerAgent

        vm.prank(strangerAgent);
        vm.expectRevert(AgentTreasury.NoPolicySet.selector);
        treasury.spend(PROVIDER_A, 10e6, keccak256("req-1"));
    }

    function test_DailyCapResetsOnNewDay() public {
        _deposit(500e6);

        vm.prank(agent);
        treasury.spend(PROVIDER_A, 100e6, keccak256("req-1")); // hits cap exactly

        vm.warp(block.timestamp + 1 days);

        vm.prank(agent);
        treasury.spend(PROVIDER_A, 100e6, keccak256("req-2")); // new day, cap refreshed
        assertEq(treasury.balanceOf(agent), 300e6);
    }

    function test_RevertWhen_NonOwnerSetsPolicy() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        treasury.setPolicy(agent, 1e6);
    }

    function test_PausedBlocksSpendAndDeposit() public {
        _deposit(50e6);
        treasury.setPaused(true);

        vm.prank(funder);
        vm.expectRevert(AgentTreasury.ContractPaused.selector);
        treasury.deposit(agent, 1e6);

        vm.prank(agent);
        vm.expectRevert(AgentTreasury.ContractPaused.selector);
        treasury.spend(PROVIDER_A, 1e6, keccak256("req-x"));
    }

    function test_AdminWithdrawOnlyWhilePaused() public {
        _deposit(50e6);

        vm.expectRevert(AgentTreasury.ContractPaused.selector);
        treasury.adminWithdraw(owner, 10e6);

        treasury.setPaused(true);
        treasury.adminWithdraw(owner, 10e6);
        assertEq(usdc.balanceOf(owner), 10e6);
    }
}
