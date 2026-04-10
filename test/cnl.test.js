const { expect } = require('chai');
const path = require('path');
const fs   = require('fs');

const { parse    } = require('../cnl/parser');
const { analyse  } = require('../cnl/datalog');
const { compile  } = require('../cnl/compiler');

describe('CNL Pipeline', function () {

  // ── Parser ──────────────────────────────────────────────────────────────────

  describe('Parser', function () {

    it('parses a CollateralLock clause', function () {
      const { clauses, errors } = parse('Party A locks 15 WETH as collateral for Party B');
      expect(errors).to.be.empty;
      expect(clauses).to.have.length(1);
      const c = clauses[0];
      expect(c.type).to.equal('CollateralLock');
      expect(c.party).to.equal('Party A');
      expect(c.amount).to.equal('15');
      expect(c.token).to.equal('WETH');
      expect(c.forParty).to.equal('Party B');
    });

    it('parses a Transfer clause', function () {
      const { clauses, errors } = parse('Party A transfers 100 USDC to Party B');
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('Transfer');
      expect(c.from).to.equal('Party A');
      expect(c.to).to.equal('Party B');
      expect(c.amount).to.equal('100');
      expect(c.token).to.equal('USDC');
    });

    it('parses a Transfer with "as premium"', function () {
      const { clauses, errors } = parse('Party A transfers 100 USDC to Party B as premium');
      expect(errors).to.be.empty;
      expect(clauses[0].asPremium).to.be.true;
    });

    it('parses a "receives from" clause (syntactic sugar for Transfer)', function () {
      const { clauses, errors } = parse('Party A receives 1000 USDC from vault');
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('Transfer');
      expect(c.from).to.equal('vault');
      expect(c.to).to.equal('Party A');
    });

    it('parses an Obligation clause', function () {
      const { clauses, errors } = parse('Party B must transfer 500 WETH to Party A within 30 days');
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('Obligation');
      expect(c.party).to.equal('Party B');
      expect(c.to).to.equal('Party A');
      expect(c.deadline.unit).to.equal('days');
      expect(c.deadline.amount).to.equal('30');
    });

    it('parses a MarginCall clause', function () {
      const { clauses, errors } = parse(
        'if price of WETH falls below 1500 USD, trigger margin call requiring 2 WETH top-up within 24 hours'
      );
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('MarginCall');
      expect(c.condition.type).to.equal('PriceBelow');
      expect(c.condition.token).to.equal('WETH');
      expect(c.condition.price).to.equal('1500');
      expect(c.topUpAmount).to.equal('2');
      expect(c.topUpToken).to.equal('WETH');
      expect(c.deadline.unit).to.equal('hours');
    });

    it('parses a ConditionalTransfer clause (PriceAbove)', function () {
      const { clauses, errors } = parse(
        'if price of WETH rises above 2500 USD, Party A receives 1000 USDC from vault'
      );
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('ConditionalTransfer');
      expect(c.condition.type).to.equal('PriceAbove');
      expect(c.condition.price).to.equal('2500');
      expect(c.to).to.equal('Party A');
    });

    it('parses an Option clause', function () {
      const { clauses, errors } = parse(
        'Party A may exercise option to receive 10 WETH for 20000 USDC within 30 days'
      );
      expect(errors).to.be.empty;
      const c = clauses[0];
      expect(c.type).to.equal('Option');
      expect(c.holder).to.equal('Party A');
      expect(c.receiveAmount).to.equal('10');
      expect(c.receiveToken).to.equal('WETH');
      expect(c.giveAmount).to.equal('20000');
      expect(c.giveToken).to.equal('USDC');
      expect(c.expiry.unit).to.equal('days');
    });

    it('collects parties and token symbols', function () {
      const { parties, tokens } = parse(
        'Party A locks 15 WETH as collateral for Party B'
      );
      expect(parties).to.include('Party A');
      expect(parties).to.include('Party B');
      expect(tokens).to.include('WETH');
    });

    it('records parse errors without throwing', function () {
      const { clauses, errors } = parse('this is not a valid clause at all');
      expect(errors).to.have.length(1);
      expect(errors[0].message).to.be.a('string');
    });

    it('skips comment lines', function () {
      const text = `// this is a comment\nParty A transfers 50 USDC to Party B`;
      const { clauses } = parse(text);
      expect(clauses).to.have.length(1);
    });
  });

  // ── Datalog ─────────────────────────────────────────────────────────────────

  describe('Datalog analysis', function () {

    it('warns when locked collateral has no return path', function () {
      // Lock WETH but never return it
      const ast    = parse('Party A locks 15 WETH as collateral');
      const result = analyse(ast);
      const hasWarn = result.warnings.some(w => w.includes('Collateral completeness'));
      expect(hasWarn).to.be.true;
    });

    it('passes collateral completeness when a return clause exists', function () {
      const text = [
        'Party A locks 15 WETH as collateral',
        'if price of WETH rises above 3000 USD, Party A receives 15 WETH from vault',
      ].join('\n');
      const result = analyse(parse(text));
      const hasCollateralWarn = result.warnings.some(w => w.includes('Collateral completeness'));
      expect(hasCollateralWarn).to.be.false;
    });

    it('warns when obligation party never receives the required token', function () {
      // Party B must pay USDC but no clause gives Party B USDC
      const ast    = parse('Party B must transfer 100 USDC to Party A within 7 days');
      const result = analyse(ast);
      expect(result.warnings.some(w => w.includes('Obligation satisfiability'))).to.be.true;
    });

    it('warns when margin call references an unlocked token', function () {
      // Margin call on WETH price but no WETH collateral lock
      const ast    = parse('if price of WETH falls below 1000 USD, trigger margin call requiring 1 WETH top-up within 12 hours');
      const result = analyse(ast);
      expect(result.warnings.some(w => w.includes('Oracle coverage'))).to.be.true;
    });

    it('does not warn on oracle coverage when collateral matches', function () {
      const text = [
        'Party A locks 10 WETH as collateral',
        'if price of WETH falls below 1000 USD, trigger margin call requiring 1 WETH top-up within 12 hours',
      ].join('\n');
      const result = analyse(parse(text));
      expect(result.warnings.some(w => w.includes('Oracle coverage'))).to.be.false;
    });

    it('warns on option without expiry', function () {
      const ast    = parse('Party A may exercise option to receive 10 WETH for 20000 USDC');
      const result = analyse(ast);
      expect(result.warnings.some(w => w.includes('Option expiry'))).to.be.true;
    });

    it('does not warn on option with expiry', function () {
      const ast    = parse('Party A may exercise option to receive 10 WETH for 20000 USDC within 30 days');
      const result = analyse(ast);
      expect(result.warnings.some(w => w.includes('Option expiry'))).to.be.false;
    });

    it('returns isValid=true when there are only warnings, not errors', function () {
      const ast    = parse('Party A locks 15 WETH as collateral');
      const result = analyse(ast);
      expect(result.isValid).to.be.true; // warnings only, no errors
    });
  });

  // ── Compiler ────────────────────────────────────────────────────────────────

  describe('Compiler', function () {

    function compileSingle(clause) {
      return compile(parse(clause), 'TestContract');
    }

    it('generates a Solidity contract', function () {
      const sol = compileSingle('Party A transfers 100 USDC to Party B');
      expect(sol).to.include('contract TestContract');
      expect(sol).to.include('pragma solidity');
      expect(sol).to.include('ReentrancyGuard');
    });

    it('emits a CEI-pattern function for CollateralLock', function () {
      const sol = compileSingle('Party A locks 15 WETH as collateral');
      expect(sol).to.include('function lockCollateral_1');
      expect(sol).to.include('safeTransferFrom');
      expect(sol).to.include('emit CollateralLocked');
    });

    it('includes oracle import for price-conditional clauses', function () {
      const sol = compileSingle(
        'if price of WETH falls below 1500 USD, trigger margin call requiring 2 WETH top-up within 24 hours'
      );
      expect(sol).to.include('IOracleModule');
      expect(sol).to.include('oracleModule.getPrice()');
    });

    it('derives constants from clause operands', function () {
      const sol = compileSingle('Party A locks 15 WETH as collateral');
      expect(sol).to.include('AMOUNT_1 = 15e18');
    });

    it('generates an Obligation function with state guard', function () {
      const sol = compileSingle('Party A must repay 100 USDC to Party B within 7 days');
      expect(sol).to.include('function fulfillObligation_1');
      expect(sol).to.include('OBLIGATION_ACTIVE');
    });

    it('generates an Option function', function () {
      const sol = compileSingle(
        'Party A may exercise option to receive 10 WETH for 20000 USDC within 30 days'
      );
      expect(sol).to.include('function exerciseOption_1');
      expect(sol).to.include('OPTION_ACTIVE');
    });
  });

  // ── Example files (end-to-end) ───────────────────────────────────────────────

  describe('Example files', function () {
    const examplesDir = path.join(__dirname, '..', 'cnl', 'examples');

    for (const file of ['collateral', 'escrow', 'option']) {
      it(`parses ${file}.cnl without errors`, function () {
        const text  = fs.readFileSync(path.join(examplesDir, `${file}.cnl`), 'utf8');
        const { errors } = parse(text);
        expect(errors, `parse errors in ${file}.cnl: ${JSON.stringify(errors)}`).to.be.empty;
      });

      it(`compiles ${file}.cnl to a non-empty Solidity contract`, function () {
        const text  = fs.readFileSync(path.join(examplesDir, `${file}.cnl`), 'utf8');
        const ast   = parse(text);
        const name  = file.charAt(0).toUpperCase() + file.slice(1);
        const sol   = compile(ast, name);
        expect(sol).to.include(`contract ${name}`);
        expect(sol.length).to.be.greaterThan(200);
      });
    }
  });
});
