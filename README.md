# DeFi Computable Contracts

Proof-of-concept for DeFi-native computable contracts.

The starting point was Finn Casey-Fierro's *Smart Confirmation Contracts* (UCL 2023), which built a clean architecture for ISDA derivative contracts: a hub-and-spoke Confirmation contract, CDM-typed structs, stateless Logic Modules, and a factory. That work assumed two identified counterparties, a linear lifecycle, and no composability requirements all of which break down in DeFi. This repo figures out what survives the translation and what needs replacing.

---

## Architecture

The core idea separating *what state a contract holds* from *what logic it delegates* carries over cleanly. Everything else gets reworked.

| Finn / ISDA | This system |
|---|---|
| Confirmation Contract (bilateral, sequential lifecycle) | **Vault** — permissionless, event-driven, any address can interact |
| CDM Type Modules | **DeFiTypes** — Position, MarginCall, LiquidationRecord, SettlementInstruction |
| Logic Module stack (fix → value → settle) | **Pluggable modules** — Oracle, Liquidation, InterestRate — called on demand |
| Self-contained, no external interface | **Composability surface** — standardised deposit/borrow/repay/liquidate entry points |
| Factory | **VaultFactory + Registry** — same pattern, adds discoverability |
| Immutable post-deploy | Module addresses set at deploy, registry enables governance-controlled upgrades |

The `Vault` also wires in the `InterestRateModule` (continuous accrual, kink model) and a `MarginCall` registry — both absent in the ISDA version because ISDA handles those out-of-band via the CSA.

### CNL Compilation Pipeline

The bigger contribution is a controlled natural language pipeline that sits above the Solidity layer. The goal is to compile human-readable financial clauses into Vault interactions, mirroring what Juris (Chaiyapattanaporn 2024) did for general Ethereum contracts.

```
escrow.cnl  ──►  parser.js  ──►  datalog.js  ──►  compiler.js  ──►  Escrow.sol
                  (AST)        (analysis)        (codegen)
```

Three clause types drive the three case studies:

- **Collateral lock** — `Party A locks 15 WETH as collateral` → `vault.openPosition`
- **Margin call** — `if price of WETH falls below 1500 USD, trigger margin call requiring 2 WETH top-up within 24 hours` → `vault.triggerMarginCall`
- **Option exercise** — `Party A may exercise option to receive 10 WETH for 20000 USDC within 30 days` → state-machine function

The Datalog analysis layer (five rules) checks completeness before Solidity is generated: collateral release paths, obligation satisfiability, oracle/collateral token alignment, option expiry bounds, and party bilateral coverage.

---

## Structure

```
src/
  DeFiTypes.sol                   shared type schema
  core/
    Vault.sol                     core contract (replaces Confirmation)
    VaultFactory.sol              factory + registry
  interfaces/
    IOracleModule.sol
    ILiquidationModule.sol
    IInterestRateModule.sol
  modules/
    OracleModule.sol              Chainlink-compatible adapter
    LiquidationModule.sol         health factor, liquidation math
    InterestRateModule.sol        kink-model borrow rate + accrual
  mocks/
    MockOracleModule.sol
    MockERC20.sol

cnl/
  parser.js                       recursive-descent CNL parser → AST
  datalog.js                      five Datalog-style analysis rules
  compiler.js                     AST → Solidity contract fragment
  cli.js                          command-line interface
  examples/
    collateral.cnl                overcollateralised lending
    escrow.cnl                    collateral-backed escrow
    option.cnl                    European call option

test/
  Vault.test.js                   29 Hardhat/Mocha tests (Solidity layer)
  cnl.test.js                     CNL pipeline tests (parser, datalog, compiler)
```

---

## Quick Start

```bash
npm install

# Compile and test the Solidity contracts
npx hardhat test

# Parse and analyse a CNL file
node cnl/cli.js cnl/examples/collateral.cnl

# Parse, analyse, and emit a Solidity contract
node cnl/cli.js cnl/examples/collateral.cnl --compile
```

---

## Prior Work

| Work | Role here |
|---|---|
| Casey-Fierro (UCL 2023) — Smart Confirmation Contracts | Primary architectural comparison. Vault replaces Confirmation; Logic Modules extend his pattern. |
| Chaiyapattanaporn (UCL 2024) — Juris | CNL-to-Solidity pipeline. This repo is the DeFi compilation target for an extended Juris grammar. |
| Fattal (UCL 2021) — CoLa | Original CNL grammar foundation. |
| Kloecker (UCL 2023) — DCM Petri Nets | Vault state machines can be derived into Petri nets for behavioural cross-validation. |

---

Yashraj PARDESHI
NTU SG | Developed in collaboration with Prof Clack, UCL
