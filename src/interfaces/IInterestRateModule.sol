// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInterestRateModule — Interface for interest rate logic
/// @notice Computes borrow rates based on pool utilisation.
///         Stateless singleton, following Finn's Logic Module pattern.

interface IInterestRateModule {
    /// @notice Compute the annualised borrow rate (ray, 1e27 = 100% APR)
    /// @param totalDebtIssued Total debt currently outstanding in the vault
    /// @param debtReserves Total idle debt reserves available for lending
    /// @return rate Borrow APR scaled to 1e27 (ray units)
    function borrowRate(
        uint256 totalDebtIssued,
        uint256 debtReserves
    ) external pure returns (uint256 rate);

    /// @notice Compute the interest accrued on a debt balance over elapsed time
    /// @param principal Outstanding debt (same units as debt token)
    /// @param rate Annual borrow rate in ray (1e27)
    /// @param elapsed Seconds since last accrual
    /// @return interest Amount of interest accrued (same units as principal)
    function accrueInterest(
        uint256 principal,
        uint256 rate,
        uint256 elapsed
    ) external pure returns (uint256 interest);

    /// @notice Returns the utilisation ratio (1e18 = 100%)
    function utilisation(
        uint256 totalDebtIssued,
        uint256 debtReserves
    ) external pure returns (uint256);
}
