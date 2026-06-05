// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script, console} from "forge-std/Script.sol";

import {GameSettlement} from "../src/GameSettlement.sol";

/// @notice EXAMPLE deployment for the GameSettlement attestor. Swap this out for your game's
///         real contracts (or delete the whole package if your game only uses TTG's rails).
///
///         Reads the deployer key from the `PRIVATE_KEY` env var and uses that account as the
///         initial owner (the game backend signer). Override the owner with the optional
///         `SETTLEMENT_OWNER` env var if the backend signer differs from the deployer.
///
///         Run against the local Anvil started by deploy/docker-compose.anvil.yml (or `anvil`):
///
///           # anvil account #0 (well-known dev key -- NEVER use on a public network):
///           export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
///           forge script script/Deploy.s.sol:Deploy \
///             --rpc-url http://localhost:8545 \
///             --broadcast
contract Deploy is Script {
    function run() external returns (GameSettlement settlement) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        // Default the owner to the deployer; allow an override for a dedicated backend signer.
        address settlementOwner = vm.envOr("SETTLEMENT_OWNER", deployer);

        vm.startBroadcast(deployerKey);
        settlement = new GameSettlement(settlementOwner);
        vm.stopBroadcast();

        console.log("GameSettlement deployed at:", address(settlement));
        console.log("Owner (backend signer):    ", settlementOwner);
    }
}
