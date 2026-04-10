// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "./Vault.sol";
import {DeFiTypes} from "../DeFiTypes.sol";

/// @title VaultFactory — Deploys and registers Vault instances
/// @author Yashraj Pardeshi
/// @notice Mirrors Finn's Factory pattern: a single factory deploys new contract
///         instances pre-wired with the correct Logic Module references.
///         Additionally provides a Registry (Finn's architecture has no equivalent)
///         so that deployed Vaults are discoverable by aggregators and UIs.

contract VaultFactory {
    // ── Registry ──

    address[] public allVaults;
    mapping(address => bool) public isVault;

    // ── Events ──

    event VaultCreated(
        address indexed vault,
        address indexed collateralToken,
        address indexed debtToken,
        address oracleModule,
        address liquidationModule
    );

    // ── Factory ──

    /// @notice Deploy a new Vault with the given configuration
    /// @param config The vault configuration (tokens, modules, risk params)
    /// @return vault The address of the newly deployed Vault
    function createVault(DeFiTypes.VaultConfig calldata config) external returns (address vault) {
        Vault v = new Vault(config);
        vault = address(v);

        allVaults.push(vault);
        isVault[vault] = true;

        emit VaultCreated(
            vault,
            config.collateralToken,
            config.debtToken,
            config.oracleModule,
            config.liquidationModule
        );
    }

    /// @notice Returns the total number of deployed vaults
    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }

    /// @notice Returns a page of vault addresses for enumeration
    function getVaults(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 end = offset + limit;
        if (end > allVaults.length) end = allVaults.length;
        if (offset >= allVaults.length) return new address[](0);

        address[] memory page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = allVaults[i];
        }
        return page;
    }
}
