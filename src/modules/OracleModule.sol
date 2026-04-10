// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleModule} from "../interfaces/IOracleModule.sol";

/// @title OracleModule — Chainlink-compatible oracle adapter
/// @notice Wraps any Chainlink AggregatorV3-style feed into the IOracleModule
///         interface. Stateless singleton — one per price pair.
///
/// Architecture note (cf. Finn §3.1.4):
///   Finn's system calls Chainlink directly from the Confirmation contract.
///   Here we abstract the oracle behind a module interface so the Vault
///   never knows whether it's reading Chainlink, a TWAP, or a Pyth feed.

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
}

contract OracleModule is IOracleModule {
    IAggregatorV3 public immutable feed;
    uint256 public constant STALE_THRESHOLD = 1 hours;

    error StalePrice(uint256 updatedAt, uint256 currentTime);
    error NegativePrice(int256 answer);

    constructor(address _feed) {
        feed = IAggregatorV3(_feed);
    }

    /// @inheritdoc IOracleModule
    function getPrice() external view override returns (uint256 price, uint256 updatedAt) {
        (, int256 answer,, uint256 _updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert NegativePrice(answer);
        if (block.timestamp - _updatedAt > STALE_THRESHOLD) {
            revert StalePrice(_updatedAt, block.timestamp);
        }
        price = uint256(answer);
        updatedAt = _updatedAt;
    }

    /// @inheritdoc IOracleModule
    function decimals() external view override returns (uint8) {
        return feed.decimals();
    }

    /// @inheritdoc IOracleModule
    function description() external view override returns (string memory) {
        return feed.description();
    }
}
