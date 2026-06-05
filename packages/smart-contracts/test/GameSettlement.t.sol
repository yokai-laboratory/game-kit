// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {GameSettlement} from "../src/GameSettlement.sol";

contract GameSettlementTest is Test {
    GameSettlement internal settlement;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    bytes32 internal constant MATCH_ID = keccak256("match-1");

    event MatchOpened(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint64 openedAt);
    event ResultReported(bytes32 indexed matchId, address indexed winner, uint64 settledAt);

    function setUp() external {
        settlement = new GameSettlement(owner);
    }

    /// @notice Happy path: owner opens a match then reports a valid winner.
    function test_openAndReport_happyPath() external {
        vm.warp(1000);

        vm.expectEmit(true, true, true, true);
        emit MatchOpened(MATCH_ID, alice, bob, uint64(1000));
        vm.prank(owner);
        settlement.openMatch(MATCH_ID, alice, bob);

        GameSettlement.Match memory opened = settlement.getMatch(MATCH_ID);
        assertEq(opened.playerA, alice);
        assertEq(opened.playerB, bob);
        assertEq(opened.winner, address(0));
        assertEq(uint8(opened.status), uint8(GameSettlement.Status.Open));
        assertEq(opened.openedAt, 1000);
        assertEq(opened.settledAt, 0);

        vm.warp(2000);
        vm.expectEmit(true, true, false, true);
        emit ResultReported(MATCH_ID, bob, uint64(2000));
        vm.prank(owner);
        settlement.reportResult(MATCH_ID, bob);

        GameSettlement.Match memory settled = settlement.getMatch(MATCH_ID);
        assertEq(settled.winner, bob);
        assertEq(uint8(settled.status), uint8(GameSettlement.Status.Settled));
        assertEq(settled.settledAt, 2000);
    }

    /// @notice Access control: a non-owner cannot open a match.
    function test_openMatch_revertsForNonOwner() external {
        vm.prank(mallory);
        vm.expectRevert(GameSettlement.NotOwner.selector);
        settlement.openMatch(MATCH_ID, alice, bob);
    }

    /// @notice Access control: a non-owner cannot report a result.
    function test_reportResult_revertsForNonOwner() external {
        vm.prank(owner);
        settlement.openMatch(MATCH_ID, alice, bob);

        vm.prank(mallory);
        vm.expectRevert(GameSettlement.NotOwner.selector);
        settlement.reportResult(MATCH_ID, alice);
    }

    /// @notice A settled match cannot be reported a second time.
    function test_reportResult_revertsOnDoubleReport() external {
        vm.startPrank(owner);
        settlement.openMatch(MATCH_ID, alice, bob);
        settlement.reportResult(MATCH_ID, alice);

        vm.expectRevert(GameSettlement.MatchNotOpen.selector);
        settlement.reportResult(MATCH_ID, bob);
        vm.stopPrank();
    }

    /// @notice The reported winner must be one of the two recorded players.
    function test_reportResult_revertsForOutsideWinner() external {
        vm.startPrank(owner);
        settlement.openMatch(MATCH_ID, alice, bob);

        vm.expectRevert(GameSettlement.WinnerNotInMatch.selector);
        settlement.reportResult(MATCH_ID, mallory);
        vm.stopPrank();
    }
}
