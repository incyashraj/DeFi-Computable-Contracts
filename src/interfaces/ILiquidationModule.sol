// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeFiTypes} from "../DeFiTypes.sol";

/// @title ILiquidationModule — Interface for liquidation logic
/// @notice Determines when positions are unhealthy and computes liquidation amounts.
///         Stateless and singleton, following Finn's Logic Module pattern.

interface ILiquidationModule {
    /// @notice Computes the health factor of a position
    /// @param collateralValue Value of collateral in debt-token terms (18 decimals)
    /// @param debtAmount Outstanding debt (in debt token units)
    /// @param liquidationThreshold The threshold in basis points * 100 (e.g. 15000 = 150%)
    /// @return healthFactor Scaled to 1e18; < 1e18 means liquidatable
    function computeHealthFactor(
        uint256 collateralValue,
        uint256 debtAmount,
        uint256 liquidationThreshold
    ) external pure returns (uint256 healthFactor);

    /// @notice Determines whether a position can be liquidated
    function isLiquidatable(
        uint256 collateralValue,
        uint256 debtAmount,
        uint256 liquidationThreshold
    ) external pure returns (bool);

    /// @notice Computes how much collateral a liquidator seizes for a given debt repayment
    /// @param debtToRepay Amount of debt the liquidator is repaying
    /// @param collateralPrice Price of collateral in debt-token terms (18 decimals)
    /// @param liquidationBonus Bonus in basis points (e.g. 500 = 5%)
    /// @return seizedCollateral Amount of collateral token transferred to liquidator
    function computeSeizedCollateral(
        uint256 debtToRepay,
        uint256 collateralPrice,
        uint256 liquidationBonus
    ) external pure returns (uint256 seizedCollateral);
}
