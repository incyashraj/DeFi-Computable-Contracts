// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DeFiTypes — Shared type schema for DeFi computable contracts
/// @author Yashraj Pardeshi
/// @notice Replaces ISDA CDM Type Modules with DeFi-native data structures.
///         Mirrors Finn Casey-Fierro's approach of typed schemas as a shared
///         vocabulary, adapted for permissionless collateralised protocols.

library DeFiTypes {
    // ──────────────────────────────────────────────
    //  Position — core state unit (replaces CDM Trade)
    // ──────────────────────────────────────────────

    struct Position {
        address owner;
        address collateralToken;
        address debtToken;
        uint256 collateralAmount;
        uint256 debtAmount;
        uint256 createdAt;       // block.timestamp at open
        uint256 lastUpdated;     // block.timestamp of last interaction
        PositionStatus status;
    }

    enum PositionStatus {
        Active,
        Liquidated,
        Closed
    }

    // ──────────────────────────────────────────────
    //  MarginCall — trigger for collateral top-up
    // ──────────────────────────────────────────────

    struct MarginCall {
        uint256 triggerPrice;    // oracle price that activates the call
        uint256 requiredTopUp;   // additional collateral needed (in collateral token units)
        uint256 deadline;        // block.timestamp by which top-up must occur
        address oracleSource;    // oracle providing the price feed
        bool triggered;
    }

    // ──────────────────────────────────────────────
    //  LiquidationEvent — record of a liquidation
    // ──────────────────────────────────────────────

    struct LiquidationRecord {
        uint256 positionId;
        address liquidator;
        uint256 seizedCollateral;
        uint256 repaidDebt;
        uint256 liquidatorBonus;
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────
    //  SettlementInstruction — atomic transfer spec
    // ──────────────────────────────────────────────

    struct SettlementInstruction {
        address from;
        address to;
        address token;
        uint256 amount;
        bytes32 conditionHash;   // keccak256 of the triggering condition (for audit)
    }

    // ──────────────────────────────────────────────
    //  VaultConfig — immutable configuration per vault
    // ──────────────────────────────────────────────

    struct VaultConfig {
        address collateralToken;
        address debtToken;
        address oracleModule;
        address liquidationModule;
        address interestRateModule;
        uint256 liquidationThreshold;  // e.g. 15000 = 150.00% (basis points * 100)
        uint256 liquidationBonus;      // e.g. 500 = 5.00%
        uint256 minCollateralAmount;
    }
}
