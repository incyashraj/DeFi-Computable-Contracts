// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestRateModule} from "../interfaces/IInterestRateModule.sol";

/// @title InterestRateModule — Linear utilisation-based interest rate model
/// @author Yashraj Pardeshi
/// @notice Computes borrow rates as a function of pool utilisation.
///         Stateless singleton — deployed once, shared across Vaults.
///
/// Architecture note (cf. Finn §3.1.4 and paper §6.2):
///   This is the Interest Rate Logic Module described in the proposed DeFi
///   architecture. It replaces the ISDA "valuation" lifecycle step with a
///   continuous rate that accrues every second on outstanding debt.
///
///   Rate model (Compound-style linear kink):
///     if utilisation <= KINK:
///       rate = BASE_RATE + utilisation * SLOPE_1
///     else:
///       rate = BASE_RATE + KINK * SLOPE_1 + (utilisation - KINK) * SLOPE_2
///
/// ── Section (i): Imports / Interface ──────────────────────────────────────
///   (above)
///
/// ── Section (ii): Events ──────────────────────────────────────────────────
///   (none — stateless pure module; Vault emits events)
///
/// ── Section (iii): Core Logic ─────────────────────────────────────────────
/// ── Section (iv): View / Helpers ──────────────────────────────────────────

contract InterestRateModule is IInterestRateModule {

    // ── Constants ──

    uint256 internal constant RAY = 1e27;        // 1 ray = 100% APR
    uint256 internal constant WAD = 1e18;        // utilisation precision
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    // Kink model parameters (compile-time; a real protocol would make these
    // governance-controlled via a module registry upgrade)
    uint256 public constant BASE_RATE  = RAY / 100;       //  1% APR base
    uint256 public constant SLOPE_1    = RAY * 4 / 100;   //  4% slope below kink
    uint256 public constant SLOPE_2    = RAY * 75 / 100;  // 75% slope above kink
    uint256 public constant KINK       = WAD * 80 / 100;  // 80% utilisation kink

    // ── Section (iii): Core Logic ──

    /// @inheritdoc IInterestRateModule
    function borrowRate(
        uint256 totalDebtIssued,
        uint256 debtReserves
    ) external pure override returns (uint256 rate) {
        uint256 util = _utilisation(totalDebtIssued, debtReserves);
        if (util <= KINK) {
            // rate = BASE + util/WAD * SLOPE_1
            rate = BASE_RATE + (util * SLOPE_1) / WAD;
        } else {
            // rate = BASE + kink/WAD * SLOPE_1 + (util-kink)/WAD * SLOPE_2
            rate = BASE_RATE
                + (KINK * SLOPE_1) / WAD
                + ((util - KINK) * SLOPE_2) / WAD;
        }
    }

    /// @inheritdoc IInterestRateModule
    function accrueInterest(
        uint256 principal,
        uint256 rate,
        uint256 elapsed
    ) external pure override returns (uint256 interest) {
        // Simple-interest approximation: principal * rate * elapsed / SECONDS_PER_YEAR / RAY
        // Accurate for short accrual periods; compound interest would require exponentiation
        interest = (principal * rate * elapsed) / (SECONDS_PER_YEAR * RAY);
    }

    // ── Section (iv): View / Helpers ──

    /// @inheritdoc IInterestRateModule
    function utilisation(
        uint256 totalDebtIssued,
        uint256 debtReserves
    ) external pure override returns (uint256) {
        return _utilisation(totalDebtIssued, debtReserves);
    }

    function _utilisation(
        uint256 totalDebtIssued,
        uint256 debtReserves
    ) internal pure returns (uint256) {
        uint256 totalLiquidity = totalDebtIssued + debtReserves;
        if (totalLiquidity == 0) return 0;
        return (totalDebtIssued * WAD) / totalLiquidity;
    }
}
