// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOracleModule — Interface for oracle logic modules
/// @notice Abstracts oracle integration so the Vault is oracle-agnostic.
///         Follows Finn's Logic Module pattern: stateless, singleton, pluggable.

interface IOracleModule {
    /// @notice Returns the latest price of the collateral in terms of the debt token
    /// @return price The price scaled to 18 decimals
    /// @return updatedAt The timestamp of the last oracle update
    function getPrice() external view returns (uint256 price, uint256 updatedAt);

    /// @notice Returns the oracle's reported decimal precision
    function decimals() external view returns (uint8);

    /// @notice Returns a human-readable description of the price feed
    function description() external view returns (string memory);
}
