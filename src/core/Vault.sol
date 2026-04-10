// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {DeFiTypes} from "../DeFiTypes.sol";
import {IOracleModule} from "../interfaces/IOracleModule.sol";
import {ILiquidationModule} from "../interfaces/ILiquidationModule.sol";
import {IInterestRateModule} from "../interfaces/IInterestRateModule.sol";

/// @title Vault — Core DeFi computable contract
/// @author Yashraj Pardeshi
/// @notice Replaces Finn's Confirmation Smart Contract for DeFi use cases.
///
/// ┌──────────────────────────────────────────────────────────────────┐
/// │  ARCHITECTURAL COMPARISON WITH FINN'S CONFIRMATION CONTRACT     │
/// │                                                                  │
/// │  Finn (ISDA):                                                   │
/// │    - Bilateral (Party A ↔ Party B)                              │
/// │    - Sequential lifecycle (create→fix→value→settle→complete)    │
/// │    - CDM Type Modules for shared data schema                    │
/// │    - Logic Modules called in a stack for each lifecycle step    │
/// │    - Self-contained; not designed for external composability    │
/// │                                                                  │
/// │  This Vault (DeFi):                                             │
/// │    - Permissionless (any address can deposit/borrow/liquidate)  │
/// │    - Event-driven (interactions at any block, any order)        │
/// │    - DeFiTypes for shared data schema                           │
/// │    - Logic Modules (Oracle, Liquidation) called as needed       │
/// │    - Composability surface (standardised external entry points) │
/// └──────────────────────────────────────────────────────────────────┘

contract Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutable configuration (set at deployment by Factory) ──

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IOracleModule public immutable oracleModule;
    ILiquidationModule public immutable liquidationModule;
    IInterestRateModule public immutable interestRateModule;
    uint256 public immutable liquidationThreshold; // e.g. 15000 = 150%
    uint256 public immutable liquidationBonus;     // e.g. 500 = 5%
    uint256 public immutable minCollateralAmount;

    // ── State ──

    uint256 public nextPositionId;
    mapping(uint256 => DeFiTypes.Position) public positions;
    mapping(address => uint256[]) public ownerPositions;

    // ── Debt pool (simplified model: vault lends from its own reserves) ──

    uint256 public totalDebtIssued;
    uint256 public debtReserves; // debt tokens deposited by lenders

    // ── MarginCall registry — maps positionId → active margin call ──

    mapping(uint256 => DeFiTypes.MarginCall) public marginCalls;

    // ── Events ──

    event PositionOpened(uint256 indexed positionId, address indexed owner, uint256 collateral, uint256 debt);
    event CollateralAdded(uint256 indexed positionId, uint256 amount);
    event DebtRepaid(uint256 indexed positionId, uint256 amount);
    event PositionClosed(uint256 indexed positionId);
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed liquidator,
        uint256 seizedCollateral,
        uint256 repaidDebt,
        uint256 bonus
    );
    event DebtReservesDeposited(address indexed lender, uint256 amount);
    event InterestAccrued(uint256 indexed positionId, uint256 interest);
    event MarginCallTriggered(uint256 indexed positionId, uint256 triggerPrice, uint256 requiredTopUp, uint256 deadline);
    event MarginCallSatisfied(uint256 indexed positionId);

    // ── Errors ──

    error NotPositionOwner();
    error PositionNotActive();
    error InsufficientCollateral();
    error InsufficientDebtReserves();
    error PositionNotLiquidatable();
    error ZeroAmount();
    error DebtNotFullyRepaid();
    error MarginCallAlreadyActive();
    error MarginCallNotTriggered();

    // ── Constructor ──

    constructor(DeFiTypes.VaultConfig memory _config) {
        collateralToken = IERC20(_config.collateralToken);
        debtToken = IERC20(_config.debtToken);
        oracleModule = IOracleModule(_config.oracleModule);
        liquidationModule = ILiquidationModule(_config.liquidationModule);
        interestRateModule = IInterestRateModule(_config.interestRateModule);
        liquidationThreshold = _config.liquidationThreshold;
        liquidationBonus = _config.liquidationBonus;
        minCollateralAmount = _config.minCollateralAmount;
    }

    // ════════════════════════════════════════════════════════════════
    //  COMPOSABILITY SURFACE — standardised entry points
    //  (This is what Finn's architecture lacks for DeFi)
    // ════════════════════════════════════════════════════════════════

    /// @notice Supply debt tokens as reserves (simple lending)
    function depositReserves(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        debtToken.safeTransferFrom(msg.sender, address(this), amount);
        debtReserves += amount;
        emit DebtReservesDeposited(msg.sender, amount);
    }

    /// @notice Open a collateralised position — lock collateral, borrow debt
    /// @param collateralAmount Amount of collateral to lock
    /// @param debtAmount Amount of debt tokens to borrow
    /// @return positionId The ID of the newly created position
    function openPosition(
        uint256 collateralAmount,
        uint256 debtAmount
    ) external nonReentrant returns (uint256 positionId) {
        if (collateralAmount < minCollateralAmount) revert InsufficientCollateral();
        if (debtAmount > debtReserves) revert InsufficientDebtReserves();

        // Validate health factor before opening
        uint256 collateralValue = _getCollateralValue(collateralAmount);
        bool wouldBeLiquidatable = liquidationModule.isLiquidatable(
            collateralValue, debtAmount, liquidationThreshold
        );
        if (wouldBeLiquidatable) revert InsufficientCollateral();

        // Effects
        positionId = nextPositionId++;
        positions[positionId] = DeFiTypes.Position({
            owner: msg.sender,
            collateralToken: address(collateralToken),
            debtToken: address(debtToken),
            collateralAmount: collateralAmount,
            debtAmount: debtAmount,
            createdAt: block.timestamp,
            lastUpdated: block.timestamp,
            status: DeFiTypes.PositionStatus.Active
        });
        ownerPositions[msg.sender].push(positionId);
        totalDebtIssued += debtAmount;
        debtReserves -= debtAmount;

        // Interactions (checks-effects-interactions pattern)
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        debtToken.safeTransfer(msg.sender, debtAmount);

        emit PositionOpened(positionId, msg.sender, collateralAmount, debtAmount);
    }

    /// @notice Add more collateral to an existing position
    function addCollateral(uint256 positionId, uint256 amount) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (amount == 0) revert ZeroAmount();

        pos.collateralAmount += amount;
        pos.lastUpdated = block.timestamp;

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralAdded(positionId, amount);
    }

    /// @notice Repay debt on a position
    function repayDebt(uint256 positionId, uint256 amount) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();
        if (amount == 0) revert ZeroAmount();

        uint256 repayAmount = amount > pos.debtAmount ? pos.debtAmount : amount;

        pos.debtAmount -= repayAmount;
        pos.lastUpdated = block.timestamp;
        totalDebtIssued -= repayAmount;
        debtReserves += repayAmount;

        debtToken.safeTransferFrom(msg.sender, address(this), repayAmount);
        emit DebtRepaid(positionId, repayAmount);
    }

    /// @notice Close a position (debt must be fully repaid first)
    function closePosition(uint256 positionId) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (pos.debtAmount > 0) revert DebtNotFullyRepaid();

        uint256 collateralToReturn = pos.collateralAmount;
        pos.collateralAmount = 0;
        pos.status = DeFiTypes.PositionStatus.Closed;
        pos.lastUpdated = block.timestamp;

        collateralToken.safeTransfer(msg.sender, collateralToReturn);
        emit PositionClosed(positionId);
    }

    /// @notice Accrue interest on a position based on elapsed time
    /// @dev Callable by anyone; increases the debt balance by the accrued interest.
    ///      Mirrors Finn's "valuation" lifecycle step, but triggered on-demand rather
    ///      than at a pre-agreed fixing date — the DeFi pattern for continuous positions.
    function accrueInterest(uint256 positionId) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();

        uint256 elapsed = block.timestamp - pos.lastUpdated;
        if (elapsed == 0) return;

        uint256 rate = interestRateModule.borrowRate(totalDebtIssued, debtReserves);
        uint256 interest = interestRateModule.accrueInterest(pos.debtAmount, rate, elapsed);

        if (interest == 0) return;

        pos.debtAmount += interest;
        pos.lastUpdated = block.timestamp;
        totalDebtIssued += interest;

        emit InterestAccrued(positionId, interest);
    }

    /// @notice Register a margin call condition on a position (CNL-compiled entry point)
    /// @dev Maps to CNL clause: "Party A locks X as collateral for Party B until price
    ///      falls below Y USD" — compiled to a MarginCall condition in the Liquidation Module.
    ///      The margin call can later be satisfied via addCollateral() before the deadline.
    /// @param positionId   Position to associate the margin call with
    /// @param triggerPrice Oracle price (in oracle's native precision) below which the call fires
    /// @param requiredTopUp Additional collateral (in collateral token units) that must be posted
    /// @param deadlineOffset Seconds from now within which top-up must occur when triggered
    function triggerMarginCall(
        uint256 positionId,
        uint256 triggerPrice,
        uint256 requiredTopUp,
        uint256 deadlineOffset
    ) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();
        if (pos.owner != msg.sender) revert NotPositionOwner();

        DeFiTypes.MarginCall storage mc = marginCalls[positionId];
        if (mc.triggered) revert MarginCallAlreadyActive();

        mc.triggerPrice = triggerPrice;
        mc.requiredTopUp = requiredTopUp;
        mc.deadline = block.timestamp + deadlineOffset;
        mc.oracleSource = address(oracleModule);
        mc.triggered = true;

        emit MarginCallTriggered(positionId, triggerPrice, requiredTopUp, mc.deadline);
    }

    /// @notice Satisfy (clear) a margin call by posting the required collateral
    /// @dev Owner calls this after adding collateral via addCollateral().
    ///      The call checks the current oracle price and verifies top-up was sufficient.
    function satisfyMarginCall(uint256 positionId) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();
        if (pos.owner != msg.sender) revert NotPositionOwner();

        DeFiTypes.MarginCall storage mc = marginCalls[positionId];
        if (!mc.triggered) revert MarginCallNotTriggered();

        // Clear the margin call once the health factor is adequate
        uint256 collateralValue = _getCollateralValue(pos.collateralAmount);
        if (liquidationModule.isLiquidatable(collateralValue, pos.debtAmount, liquidationThreshold)) {
            revert InsufficientCollateral();
        }

        mc.triggered = false;
        emit MarginCallSatisfied(positionId);
    }

    /// @notice Liquidate an unhealthy position — callable by anyone (permissionless)
    /// @param positionId Position to liquidate
    /// @param debtToRepay Amount of debt the liquidator wants to cover
    function liquidate(uint256 positionId, uint256 debtToRepay) external nonReentrant {
        DeFiTypes.Position storage pos = positions[positionId];
        if (pos.status != DeFiTypes.PositionStatus.Active) revert PositionNotActive();

        uint256 collateralValue = _getCollateralValue(pos.collateralAmount);
        if (!liquidationModule.isLiquidatable(collateralValue, pos.debtAmount, liquidationThreshold)) {
            revert PositionNotLiquidatable();
        }

        // Cap repayment at total debt
        if (debtToRepay > pos.debtAmount) debtToRepay = pos.debtAmount;

        // Ask Liquidation Module how much collateral to seize
        (uint256 price,) = oracleModule.getPrice();
        uint256 oracleDecimals = oracleModule.decimals();
        uint256 priceNormalised = price * 1e18 / (10 ** oracleDecimals);

        uint256 seized = liquidationModule.computeSeizedCollateral(
            debtToRepay, priceNormalised, liquidationBonus
        );

        // Cap at available collateral
        if (seized > pos.collateralAmount) seized = pos.collateralAmount;

        uint256 bonus = seized > (debtToRepay * 1e18 / priceNormalised)
            ? seized - (debtToRepay * 1e18 / priceNormalised)
            : 0;

        // Effects
        pos.collateralAmount -= seized;
        pos.debtAmount -= debtToRepay;
        pos.lastUpdated = block.timestamp;
        totalDebtIssued -= debtToRepay;
        debtReserves += debtToRepay;

        if (pos.debtAmount == 0 && pos.collateralAmount == 0) {
            pos.status = DeFiTypes.PositionStatus.Liquidated;
        }

        // Interactions
        debtToken.safeTransferFrom(msg.sender, address(this), debtToRepay);
        collateralToken.safeTransfer(msg.sender, seized);

        emit PositionLiquidated(positionId, msg.sender, seized, debtToRepay, bonus);
    }

    // ════════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    /// @notice Get the health factor of a position (1e18 = exactly at threshold)
    function getHealthFactor(uint256 positionId) external view returns (uint256) {
        DeFiTypes.Position storage pos = positions[positionId];
        uint256 collateralValue = _getCollateralValue(pos.collateralAmount);
        return liquidationModule.computeHealthFactor(
            collateralValue, pos.debtAmount, liquidationThreshold
        );
    }

    /// @notice Check if a position is liquidatable
    function isPositionLiquidatable(uint256 positionId) external view returns (bool) {
        DeFiTypes.Position storage pos = positions[positionId];
        uint256 collateralValue = _getCollateralValue(pos.collateralAmount);
        return liquidationModule.isLiquidatable(
            collateralValue, pos.debtAmount, liquidationThreshold
        );
    }

    /// @notice Get all position IDs for an owner
    function getOwnerPositionIds(address owner) external view returns (uint256[] memory) {
        return ownerPositions[owner];
    }

    // ── Internal helpers ──

    function _getCollateralValue(uint256 collateralAmount) internal view returns (uint256) {
        (uint256 price,) = oracleModule.getPrice();
        uint8 oracleDecimals = oracleModule.decimals();
        // Normalise to 18 decimals
        return (collateralAmount * price) / (10 ** oracleDecimals);
    }
}
