// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title GameSettlement (EXAMPLE)
/// @notice EXAMPLE on-chain match-result attestor for the game-kit template. Replace or delete it.
///
///         This contract exists ONLY to show the shape of a game that needs its OWN custom
///         on-chain logic beyond the Metatron (TRON) platform rails. It is a minimal
///         "result oracle": the game backend opens a head-to-head match between two players and
///         later attests the winner, leaving an immutable, indexable record on chain.
///
///         IMPORTANT -- DO NOT route real money through this example. Payments, pots, entry fees
///         and prize distribution for a TRON game flow through the platform's CreditVault pots
///         (see packages/smart-contracts in the metatron monorepo / the TRON SDK), which
///         handle escrow, fees, disputes and signed payouts. This contract deliberately holds no
///         funds; it is just an attestation/registry demo you can swap for whatever bespoke
///         logic your game actually needs (e.g. on-chain leaderboards, NFT mints, commit-reveal).
///
/// @dev Access control is an intentionally tiny inline `onlyOwner` so the scaffold pulls in no
///      dependency beyond forge-std (for tests). A production contract should prefer an audited
///      library (e.g. OpenZeppelin Ownable2Step) and likely EIP-712 signatures rather than a
///      single hot owner key.
contract GameSettlement {
    /// @notice Lifecycle of a match.
    enum Status {
        None, // never opened
        Open, // opened, awaiting a result
        Settled // result reported, terminal

    }

    /// @notice Full on-chain record for a single match.
    struct Match {
        address playerA;
        address playerB;
        address winner; // address(0) until settled
        Status status;
        uint64 openedAt; // block timestamp at openMatch
        uint64 settledAt; // block timestamp at reportResult (0 until settled)
    }

    /// @notice The game backend signer allowed to open matches and report results.
    address public owner;

    /// @notice matchId => record.
    mapping(bytes32 => Match) private _matches;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event MatchOpened(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint64 openedAt);
    event ResultReported(bytes32 indexed matchId, address indexed winner, uint64 settledAt);

    error NotOwner();
    error ZeroAddress();
    error InvalidPlayers();
    error MatchAlreadyExists();
    error MatchNotOpen();
    error WinnerNotInMatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param initialOwner The game backend signer. Usually the deployer or a dedicated hot wallet.
    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnerTransferred(address(0), initialOwner);
    }

    /// @notice Hand the owner role to a new backend signer.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Open a head-to-head match between two distinct players.
    /// @param matchId Opaque id minted off chain (e.g. keccak256 of the TRON match id).
    /// @param playerA First player.
    /// @param playerB Second player.
    function openMatch(bytes32 matchId, address playerA, address playerB) external onlyOwner {
        if (playerA == address(0) || playerB == address(0)) revert ZeroAddress();
        if (playerA == playerB) revert InvalidPlayers();
        if (_matches[matchId].status != Status.None) revert MatchAlreadyExists();

        uint64 nowTs = uint64(block.timestamp);
        _matches[matchId] = Match({
            playerA: playerA,
            playerB: playerB,
            winner: address(0),
            status: Status.Open,
            openedAt: nowTs,
            settledAt: 0
        });

        emit MatchOpened(matchId, playerA, playerB, nowTs);
    }

    /// @notice Attest the winner of an open match. Terminal -- a match can only be reported once.
    /// @param matchId The match to settle.
    /// @param winner Must be one of the two players recorded for this match.
    function reportResult(bytes32 matchId, address winner) external onlyOwner {
        Match storage m = _matches[matchId];
        if (m.status != Status.Open) revert MatchNotOpen();
        if (winner != m.playerA && winner != m.playerB) revert WinnerNotInMatch();

        uint64 nowTs = uint64(block.timestamp);
        m.winner = winner;
        m.status = Status.Settled;
        m.settledAt = nowTs;

        emit ResultReported(matchId, winner, nowTs);
    }

    /// @notice Read the full record for a match. Returns a zeroed struct (Status.None) if unknown.
    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }
}
