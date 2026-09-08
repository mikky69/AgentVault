// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AgentTreasury.sol";

/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url base_sepolia \
///     --broadcast \
///     --verify
///
/// Required env vars: DEPLOYER_PRIVATE_KEY, SETTLEMENT_TOKEN (e.g. USDC on
/// Base Sepolia), SETTLEMENT_RELAYER (the backend-controlled address that
/// receives authorized spends before Moove routes them onward).
contract Deploy is Script {
    function run() external returns (AgentTreasury treasury) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address token = vm.envAddress("SETTLEMENT_TOKEN");
        address relayer = vm.envAddress("SETTLEMENT_RELAYER");

        vm.startBroadcast(deployerKey);
        treasury = new AgentTreasury(token, relayer);
        vm.stopBroadcast();

        console.log("AgentTreasury deployed at:", address(treasury));
    }
}
