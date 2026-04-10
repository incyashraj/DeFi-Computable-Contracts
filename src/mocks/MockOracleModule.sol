// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleModule} from "../interfaces/IOracleModule.sol";

/// @title MockOracleModule — Test oracle with controllable price
/// @notice Used in tests to simulate oracle price movements and liquidation triggers.

contract MockOracleModule is IOracleModule {
    int256 private _price;
    uint8 private _decimals;
    uint256 private _updatedAt;

    constructor(int256 initialPrice, uint8 dec) {
        _price = initialPrice;
        _decimals = dec;
        _updatedAt = block.timestamp;
    }

    function setPrice(int256 newPrice) external {
        _price = newPrice;
        _updatedAt = block.timestamp;
    }

    function getPrice() external view override returns (uint256 price, uint256 updatedAt) {
        require(_price > 0, "MockOracle: negative price");
        return (uint256(_price), _updatedAt);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function description() external pure override returns (string memory) {
        return "Mock ETH/USD";
    }
}
