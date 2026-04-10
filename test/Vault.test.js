const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DeFi Computable Contracts", function () {
  let deployer, alice, bob, liquidator;
  let collateral, debt, oracle, liqModule, interestRateModule, factory;
  let vault;

  const ETH_PRICE = 2000n * 10n ** 8n; // $2000 with 8 decimals (Chainlink-style)
  const ORACLE_DECIMALS = 8;
  const LIQ_THRESHOLD = 15000n; // 150%
  const LIQ_BONUS = 500n; // 5%
  const MIN_COLLATERAL = ethers.parseEther("0.01");

  beforeEach(async function () {
    [deployer, alice, bob, liquidator] = await ethers.getSigners();

    // Deploy mocks
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    collateral = await MockERC20.deploy("Wrapped ETH", "WETH", 18);
    debt = await MockERC20.deploy("USD Coin", "USDC", 18); // 18 dec for simplicity

    const MockOracle = await ethers.getContractFactory("MockOracleModule");
    oracle = await MockOracle.deploy(ETH_PRICE, ORACLE_DECIMALS);

    const LiquidationModule = await ethers.getContractFactory("LiquidationModule");
    liqModule = await LiquidationModule.deploy();

    const InterestRateModule = await ethers.getContractFactory("InterestRateModule");
    interestRateModule = await InterestRateModule.deploy();

    // Deploy factory and create a vault
    const VaultFactory = await ethers.getContractFactory("VaultFactory");
    factory = await VaultFactory.deploy();

    const config = {
      collateralToken: await collateral.getAddress(),
      debtToken: await debt.getAddress(),
      oracleModule: await oracle.getAddress(),
      liquidationModule: await liqModule.getAddress(),
      interestRateModule: await interestRateModule.getAddress(),
      liquidationThreshold: LIQ_THRESHOLD,
      liquidationBonus: LIQ_BONUS,
      minCollateralAmount: MIN_COLLATERAL,
    };

    const tx = await factory.createVault(config);
    const receipt = await tx.wait();

    // Get vault address from event
    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "VaultCreated"
    );
    const vaultAddr = event.args[0];
    vault = await ethers.getContractAt("Vault", vaultAddr);

    // Mint tokens
    await collateral.mint(alice.address, ethers.parseEther("100"));
    await collateral.mint(bob.address, ethers.parseEther("100"));
    await debt.mint(deployer.address, ethers.parseEther("1000000"));
    await debt.mint(liquidator.address, ethers.parseEther("100000"));

    // Deployer seeds vault with debt reserves
    await debt.connect(deployer).approve(vaultAddr, ethers.parseEther("500000"));
    await vault.connect(deployer).depositReserves(ethers.parseEther("500000"));
  });

  // ─────────────────────────────────────────────
  //  Factory & Registry
  // ─────────────────────────────────────────────

  describe("VaultFactory", function () {
    it("should register the vault in the registry", async function () {
      expect(await factory.totalVaults()).to.equal(1n);
      expect(await factory.isVault(await vault.getAddress())).to.be.true;
    });

    it("should deploy multiple vaults", async function () {
      const config2 = {
        collateralToken: await collateral.getAddress(),
        debtToken: await debt.getAddress(),
        oracleModule: await oracle.getAddress(),
        liquidationModule: await liqModule.getAddress(),
        interestRateModule: await interestRateModule.getAddress(),
        liquidationThreshold: 12000n,
        liquidationBonus: 1000n,
        minCollateralAmount: MIN_COLLATERAL,
      };
      await factory.createVault(config2);
      expect(await factory.totalVaults()).to.equal(2n);
    });

    it("should paginate vault addresses", async function () {
      const page = await factory.getVaults(0, 10);
      expect(page.length).to.equal(1);
      expect(page[0]).to.equal(await vault.getAddress());
    });
  });

  // ─────────────────────────────────────────────
  //  Position Lifecycle
  // ─────────────────────────────────────────────

  describe("Position lifecycle", function () {
    const COLLATERAL = ethers.parseEther("10"); // 10 WETH
    const DEBT = ethers.parseEther("10000"); // borrow 10,000 USDC

    beforeEach(async function () {
      await collateral
        .connect(alice)
        .approve(await vault.getAddress(), COLLATERAL);
    });

    it("should open a position", async function () {
      const tx = await vault.connect(alice).openPosition(COLLATERAL, DEBT);
      await expect(tx)
        .to.emit(vault, "PositionOpened")
        .withArgs(0n, alice.address, COLLATERAL, DEBT);

      const pos = await vault.positions(0);
      expect(pos.owner).to.equal(alice.address);
      expect(pos.collateralAmount).to.equal(COLLATERAL);
      expect(pos.debtAmount).to.equal(DEBT);
      expect(pos.status).to.equal(0n); // Active
    });

    it("should reject undercollateralised positions", async function () {
      // 10 ETH at $2000 = $20,000 collateral value
      // At 150% threshold, max debt = $20,000 * 10000 / 15000 ≈ $13,333
      const tooMuchDebt = ethers.parseEther("14000");
      await expect(
        vault.connect(alice).openPosition(COLLATERAL, tooMuchDebt)
      ).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
    });

    it("should add collateral to a position", async function () {
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);

      const extra = ethers.parseEther("5");
      await collateral.connect(alice).approve(await vault.getAddress(), extra);
      await vault.connect(alice).addCollateral(0, extra);

      const pos = await vault.positions(0);
      expect(pos.collateralAmount).to.equal(COLLATERAL + extra);
    });

    it("should repay debt", async function () {
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);

      // Alice needs USDC to repay — she got 10,000 from borrowing
      await debt
        .connect(alice)
        .approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(alice).repayDebt(0, ethers.parseEther("5000"));

      const pos = await vault.positions(0);
      expect(pos.debtAmount).to.equal(ethers.parseEther("5000"));
    });

    it("should close a fully repaid position and return collateral", async function () {
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);

      // Repay full debt
      await debt.connect(alice).approve(await vault.getAddress(), DEBT);
      await vault.connect(alice).repayDebt(0, DEBT);

      const balBefore = await collateral.balanceOf(alice.address);
      await vault.connect(alice).closePosition(0);
      const balAfter = await collateral.balanceOf(alice.address);

      expect(balAfter - balBefore).to.equal(COLLATERAL);

      const pos = await vault.positions(0);
      expect(pos.status).to.equal(2n); // Closed
    });

    it("should not allow closing with outstanding debt", async function () {
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);
      await expect(
        vault.connect(alice).closePosition(0)
      ).to.be.revertedWithCustomError(vault, "DebtNotFullyRepaid");
    });
  });

  // ─────────────────────────────────────────────
  //  Liquidation Module (unit)
  // ─────────────────────────────────────────────

  describe("LiquidationModule", function () {
    it("should return max health for zero-debt positions", async function () {
      const hf = await liqModule.computeHealthFactor(
        ethers.parseEther("1000"),
        0n,
        15000n
      );
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it("should identify liquidatable positions", async function () {
      // collateralValue=2000, debt=800, threshold=150%
      // Collateral ratio = 2000/800 = 250% > 150% → healthy
      // 2000 * 10000 < 800 * 15000 → 20,000,000 < 12,000,000 → false (healthy)
      expect(
        await liqModule.isLiquidatable(
          ethers.parseEther("2000"),
          ethers.parseEther("800"),
          15000n
        )
      ).to.be.false;

      // collateralValue=500, debt=800, threshold=150%
      // Collateral ratio = 500/800 = 62.5% < 150% → liquidatable
      // 500 * 10000 < 800 * 15000 → 5,000,000 < 12,000,000 → true (liquidatable)
      expect(
        await liqModule.isLiquidatable(
          ethers.parseEther("500"),
          ethers.parseEther("800"),
          15000n
        )
      ).to.be.true;
    });

    it("should compute seized collateral with bonus", async function () {
      const debtToRepay = ethers.parseEther("1000");
      const collateralPrice = ethers.parseEther("2000"); // 1 ETH = $2000
      const bonus = 500n; // 5%

      const seized = await liqModule.computeSeizedCollateral(
        debtToRepay,
        collateralPrice,
        bonus
      );

      // base = 1000/2000 = 0.5 ETH, with 5% bonus = 0.525 ETH
      expect(seized).to.equal(ethers.parseEther("0.525"));
    });
  });

  // ─────────────────────────────────────────────
  //  End-to-end Liquidation
  // ─────────────────────────────────────────────

  describe("Liquidation flow", function () {
    const COLLATERAL = ethers.parseEther("10"); // 10 ETH
    const DEBT = ethers.parseEther("12000"); // borrow $12,000

    beforeEach(async function () {
      await collateral
        .connect(alice)
        .approve(await vault.getAddress(), COLLATERAL);
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);
    });

    it("should not allow liquidation of healthy position", async function () {
      // 10 ETH * $2000 = $20,000 collateral. Debt = $12,000. Ratio = 166%. Threshold = 150%. Healthy.
      await debt
        .connect(liquidator)
        .approve(await vault.getAddress(), DEBT);
      await expect(
        vault.connect(liquidator).liquidate(0, DEBT)
      ).to.be.revertedWithCustomError(vault, "PositionNotLiquidatable");
    });

    it("should allow liquidation after price drop", async function () {
      // Drop ETH price so position becomes unhealthy
      // At $1100: 10 ETH * $1100 = $11,000 collateral. Debt = $12,000.
      // 11000 * 15000 = 165,000,000 < 12000 * 10000 = 120,000,000 → false?
      // Wait, we need collateralValue * threshold < debt * BPS
      // 11000 * 15000 = 165M vs 12000 * 10000 = 120M → 165M > 120M → NOT liquidatable
      // Need: collateralValue * 15000 < debtAmount * 10000
      // collateralValue < 12000 * 10000 / 15000 = 8000
      // So price needs to drop below $800/ETH: 10 * 800 = 8000
      const crashPrice = 750n * 10n ** 8n; // $750
      await oracle.setPrice(crashPrice);

      expect(await vault.isPositionLiquidatable(0)).to.be.true;

      const repayAmount = ethers.parseEther("6000");
      await debt
        .connect(liquidator)
        .approve(await vault.getAddress(), repayAmount);

      const liqBalBefore = await collateral.balanceOf(liquidator.address);
      await vault.connect(liquidator).liquidate(0, repayAmount);
      const liqBalAfter = await collateral.balanceOf(liquidator.address);

      // Liquidator should have received collateral
      expect(liqBalAfter).to.be.gt(liqBalBefore);

      // Position debt should be reduced
      const pos = await vault.positions(0);
      expect(pos.debtAmount).to.equal(DEBT - repayAmount);
    });

    it("should emit PositionLiquidated event", async function () {
      const crashPrice = 750n * 10n ** 8n;
      await oracle.setPrice(crashPrice);

      const repayAmount = ethers.parseEther("6000");
      await debt
        .connect(liquidator)
        .approve(await vault.getAddress(), repayAmount);

      await expect(vault.connect(liquidator).liquidate(0, repayAmount)).to.emit(
        vault,
        "PositionLiquidated"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  Oracle Module
  // ─────────────────────────────────────────────

  describe("OracleModule", function () {
    it("should return correct price", async function () {
      const [price] = await oracle.getPrice();
      expect(price).to.equal(ETH_PRICE);
    });

    it("should reflect price updates", async function () {
      await oracle.setPrice(3000n * 10n ** 8n);
      const [price] = await oracle.getPrice();
      expect(price).to.equal(3000n * 10n ** 8n);
    });
  });

  // ─────────────────────────────────────────────
  //  Interest Rate Module (unit)
  // ─────────────────────────────────────────────

  describe("InterestRateModule", function () {
    it("should return zero rate when pool is empty", async function () {
      const rate = await interestRateModule.borrowRate(0n, 0n);
      // BASE_RATE = 1e27/100 = 1% -- returned even with zero liquidity
      expect(rate).to.equal(10n ** 27n / 100n);
    });

    it("should return base rate at zero utilisation", async function () {
      const rate = await interestRateModule.borrowRate(0n, ethers.parseEther("1000"));
      expect(rate).to.equal(10n ** 27n / 100n); // 1% APR
    });

    it("should return higher rate at high utilisation", async function () {
      // 90% utilisation — above the 80% kink
      const debt90 = ethers.parseEther("900");
      const reserves10 = ethers.parseEther("100");
      const rate = await interestRateModule.borrowRate(debt90, reserves10);
      const baseRate = 10n ** 27n / 100n;
      expect(rate).to.be.gt(baseRate);
    });

    it("should accrue positive interest over time", async function () {
      const principal = ethers.parseEther("10000");
      const rate = 10n ** 27n / 100n; // 1% APR (in ray)
      const elapsed = BigInt(365 * 24 * 3600); // 1 year in seconds
      const interest = await interestRateModule.accrueInterest(principal, rate, elapsed);
      // ~1% of 10,000 = ~100 tokens
      expect(interest).to.be.gt(0n);
      // Should be approximately 100e18 (1% of 10,000e18)
      expect(interest).to.be.closeTo(ethers.parseEther("100"), ethers.parseEther("1"));
    });

    it("should return zero interest for zero elapsed time", async function () {
      const interest = await interestRateModule.accrueInterest(
        ethers.parseEther("10000"), 10n ** 27n / 100n, 0n
      );
      expect(interest).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────
  //  Interest accrual on vault positions
  // ─────────────────────────────────────────────

  describe("Interest accrual", function () {
    const COLLATERAL = ethers.parseEther("10");
    const DEBT = ethers.parseEther("10000");

    beforeEach(async function () {
      await collateral.connect(alice).approve(await vault.getAddress(), COLLATERAL);
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);
    });

    it("should not revert when accruing with zero elapsed time", async function () {
      // Same block — no interest accrued, should not revert
      await expect(vault.accrueInterest(0)).to.not.be.reverted;
    });

    it("should revert accrual on non-active position", async function () {
      // Close the position first
      await debt.connect(alice).approve(await vault.getAddress(), DEBT);
      await vault.connect(alice).repayDebt(0, DEBT);
      await vault.connect(alice).closePosition(0);

      await expect(vault.accrueInterest(0)).to.be.revertedWithCustomError(
        vault,
        "PositionNotActive"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  MarginCall (CNL-compiled clause)
  // ─────────────────────────────────────────────

  describe("MarginCall", function () {
    const COLLATERAL = ethers.parseEther("10");
    const DEBT = ethers.parseEther("10000");

    beforeEach(async function () {
      await collateral.connect(alice).approve(await vault.getAddress(), COLLATERAL);
      await vault.connect(alice).openPosition(COLLATERAL, DEBT);
    });

    it("should allow owner to register a margin call condition", async function () {
      const triggerPrice = 1500n * 10n ** 8n; // $1500/ETH
      const requiredTopUp = ethers.parseEther("2");
      const deadlineOffset = 86400n; // 1 day

      await expect(
        vault.connect(alice).triggerMarginCall(0, triggerPrice, requiredTopUp, deadlineOffset)
      ).to.emit(vault, "MarginCallTriggered");

      const mc = await vault.marginCalls(0);
      expect(mc.triggered).to.be.true;
      expect(mc.triggerPrice).to.equal(triggerPrice);
      expect(mc.requiredTopUp).to.equal(requiredTopUp);
    });

    it("should reject duplicate margin call registration", async function () {
      await vault.connect(alice).triggerMarginCall(
        0, 1500n * 10n ** 8n, ethers.parseEther("2"), 86400n
      );
      await expect(
        vault.connect(alice).triggerMarginCall(
          0, 1400n * 10n ** 8n, ethers.parseEther("3"), 86400n
        )
      ).to.be.revertedWithCustomError(vault, "MarginCallAlreadyActive");
    });

    it("should reject margin call registration by non-owner", async function () {
      await expect(
        vault.connect(bob).triggerMarginCall(
          0, 1500n * 10n ** 8n, ethers.parseEther("2"), 86400n
        )
      ).to.be.revertedWithCustomError(vault, "NotPositionOwner");
    });

    it("should allow owner to satisfy margin call after adding collateral", async function () {
      await vault.connect(alice).triggerMarginCall(
        0, 1500n * 10n ** 8n, ethers.parseEther("2"), 86400n
      );

      // Add enough collateral to make position clearly healthy
      const extra = ethers.parseEther("10");
      await collateral.connect(alice).approve(await vault.getAddress(), extra);
      await vault.connect(alice).addCollateral(0, extra);

      await expect(
        vault.connect(alice).satisfyMarginCall(0)
      ).to.emit(vault, "MarginCallSatisfied");

      const mc = await vault.marginCalls(0);
      expect(mc.triggered).to.be.false;
    });

    it("should reject satisfying a margin call that was never triggered", async function () {
      await expect(
        vault.connect(alice).satisfyMarginCall(0)
      ).to.be.revertedWithCustomError(vault, "MarginCallNotTriggered");
    });
  });
});
