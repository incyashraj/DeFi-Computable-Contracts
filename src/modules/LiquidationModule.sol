// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILiquidationModule} from "../interfaces/ILiquidationModule.sol";

/// @title LiquidationModule — Stateless liquidation logic
/// @notice Computes health factors and liquidation amounts.
///         Deployed once, referenced by many Vaults (singleton pattern).
///
/// Architecture note (cf. Finn §3.1.4–§3.1.5):
///   Finn's Logic Modules follow a four-section standard:
///     (i) imports/interfaces  (ii) events  (iii) core logic  (iv) view/helpers
///   We preserve this structure. This module is pure computation — no state,
///   no storage, no token transfers. The Vault calls it for decisions only.

contract LiquidationModule is ILiquidationModule {

    // ── Section (ii): Events ──
    // (none needed — this module is pure/view only; Vault emits events)

    // ── Section (iii): Core Logic ──

    uint256 internal constant PRECISION = 1e18;
    uint256 internal constant BPS_PRECISION = 10_000; // basis points

    /// @inheritdoc ILiquidationModule
    function computeHealthFactor(
        uint256 collateralValue,
        uint256 debtAmount,
        uint256 liquidationThreshold
    ) public pure override returns (uint256 healthFactor) {
        if (debtAmount == 0) return type(uint256).max; // no debt = infinite health
        // healthFactor = (collateralValue / (debtAmount * threshold / BPS)) scaled to 1e18
        // = (collateralValue * BPS_PRECISION * PRECISION) / (debtAmount * liquidationThreshold)
        // HF > 1e18 → healthy; HF < 1e18 → liquidatable
        healthFactor = (collateralValue * BPS_PRECISION * PRECISION)
            / (debtAmount * liquidationThreshold);
    }

    /// @inheritdoc ILiquidationModule
    function isLiquidatable(
        uint256 collateralValue,
        uint256 debtAmount,
        uint256 liquidationThreshold
    ) external pure override returns (bool) {
        if (debtAmount == 0) return false;
        // Position is liquidatable when collateral < required minimum:
        //   collateralValue < debtAmount * liquidationThreshold / BPS_PRECISION
        // Rearranged to avoid division:
        //   collateralValue * BPS_PRECISION < debtAmount * liquidationThreshold
        return collateralValue * BPS_PRECISION < debtAmount * liquidationThreshold;
    }

    // ── Section (iv): View / Helpers ──

    /// @inheritdoc ILiquidationModule
    function computeSeizedCollateral(
        uint256 debtToRepay,
        uint256 collateralPrice,
        uint256 liquidationBonus
    ) external pure override returns (uint256 seizedCollateral) {
        // seizedCollateral = (debtToRepay / collateralPrice) * (1 + bonus)
        // All values in 18-decimal precision
        uint256 baseCollateral = (debtToRepay * PRECISION) / collateralPrice;
        seizedCollateral = baseCollateral + (baseCollateral * liquidationBonus) / BPS_PRECISION;
    }
}
