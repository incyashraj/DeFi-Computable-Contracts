'use strict';

// ── Datalog-style analysis engine ─────────────────────────────────────────────
//
// Derives facts from the parsed clause AST and applies a set of rules to
// detect potential issues.  Inspired by the Datalog analysis layer in Juris
// (Chaiyapattanaporn, 2024) but adapted for DeFi-specific concerns:
//
//   Rule 1  Collateral completeness  — every lock has a corresponding release
//   Rule 2  Obligation satisfiability — the obligated party can actually pay
//   Rule 3  Oracle coverage          — margin call conditions reference locked tokens
//   Rule 4  Option expiry            — unbounded options are unusual
//   Rule 5  Party completeness       — every party both sends and receives something
//
// Returns { isValid, errors, warnings, facts }

function analyse(ast) {
  const warnings = [];
  const errors   = [];

  // ── Fact extraction ──────────────────────────────────────────────────────────
  //
  // Build relation tables from the clause set.  These are the "extensional
  // database" (EDB) in Datalog terms; the rules below derive the "intensional
  // database" (IDB).

  const canSend    = {};  // party → Set<token>
  const canReceive = {};  // party → Set<token>

  const lockedCollateral = []; // CollateralLock clauses
  const obligations      = []; // Obligation clauses
  const marginCalls      = []; // MarginCall clauses
  const options          = []; // Option clauses

  for (const clause of ast.clauses) {
    switch (clause.type) {
      case 'Transfer':
      case 'ConditionalTransfer': {
        addFact(canSend,    clause.from, clause.token);
        addFact(canReceive, clause.to,   clause.token);
        break;
      }
      case 'CollateralLock': {
        lockedCollateral.push(clause);
        addFact(canSend, clause.party, clause.token);
        break;
      }
      case 'Obligation': {
        obligations.push(clause);
        addFact(canSend,    clause.party, clause.token);
        addFact(canReceive, clause.to,    clause.token);
        break;
      }
      case 'MarginCall': {
        marginCalls.push(clause);
        break;
      }
      case 'Option': {
        options.push(clause);
        addFact(canSend,    clause.holder, clause.giveToken);
        addFact(canReceive, clause.holder, clause.receiveToken);
        break;
      }
    }
  }

  const facts = {
    canSend:          serializeSets(canSend),
    canReceive:       serializeSets(canReceive),
    lockedCollateral: lockedCollateral.map(c => ({ party: c.party, token: c.token, amount: c.amount })),
    obligations:      obligations.map(c => ({ party: c.party, token: c.token })),
    marginCalls:      marginCalls.map(c => ({ conditionToken: c.condition.token, topUpToken: c.topUpToken })),
    options:          options.map(c => ({ holder: c.holder, giveToken: c.giveToken, receiveToken: c.receiveToken })),
  };

  // ── Rule 1: Collateral completeness ──────────────────────────────────────────
  //
  // unlockedBy(party, token) ← ∃ clause of type Transfer|ConditionalTransfer
  //                              where to = party ∧ token = token
  //
  // For every lock, unlockedBy must hold.

  for (const lock of lockedCollateral) {
    const hasRelease = ast.clauses.some(c =>
      (c.type === 'Transfer' || c.type === 'ConditionalTransfer') &&
      c.to === lock.party &&
      c.token === lock.token
    );
    if (!hasRelease) {
      warnings.push(
        `Collateral completeness: '${lock.party}' locks ${lock.amount} ${lock.token} ` +
        `but no clause returns ${lock.token} to them. ` +
        `Collateral may be permanently locked — add a repay/close clause.`
      );
    }
  }

  // ── Rule 2: Obligation satisfiability ────────────────────────────────────────
  //
  // payable(party, token) ← canReceive(party, token) ∨ locksCollateral(party, token)
  //
  // If an obligation requires a token the party never receives, flag it.

  for (const ob of obligations) {
    const willReceive = (canReceive[ob.party] && canReceive[ob.party].has(ob.token)) ||
                        lockedCollateral.some(l => l.party === ob.party && l.token === ob.token);
    if (!willReceive) {
      warnings.push(
        `Obligation satisfiability: '${ob.party}' must ${ob.verb} ${ob.amount} ${ob.token} ` +
        `but no clause provides ${ob.token} to '${ob.party}'. ` +
        `Verify that '${ob.party}' holds sufficient ${ob.token} off-chain.`
      );
    }
  }

  // ── Rule 3: Oracle coverage ───────────────────────────────────────────────────
  //
  // The token referenced in a margin-call trigger condition should also appear
  // in a CollateralLock, otherwise the oracle feed and the collateral are mismatched.

  for (const mc of marginCalls) {
    const condToken      = mc.condition.token;
    const hasMatchingLock = lockedCollateral.some(l => l.token === condToken);
    if (!hasMatchingLock) {
      warnings.push(
        `Oracle coverage: margin call triggers on price of '${condToken}' ` +
        `but '${condToken}' is not locked as collateral in any clause. ` +
        `Ensure the oracle feed matches the collateral token.`
      );
    }
  }

  // ── Rule 4: Option expiry ─────────────────────────────────────────────────────
  //
  // An option without an expiry window is potentially perpetual.

  for (const opt of options) {
    if (!opt.expiry) {
      warnings.push(
        `Option expiry: '${opt.holder}' holds an option with no expiry window. ` +
        `Add 'within <duration>' to bound the exercise period.`
      );
    }
  }

  // ── Rule 5: Party completeness ────────────────────────────────────────────────
  //
  // A well-formed bilateral contract satisfies:
  //   complete(party) ← canSend(party, _) ∧ canReceive(party, _)
  //
  // Parties that only send or only receive are flagged as potentially incomplete.

  for (const party of ast.parties) {
    const sends    = canSend[party]    && canSend[party].size    > 0;
    const receives = canReceive[party] && canReceive[party].size > 0;
    if (!sends && !receives) {
      errors.push(`Party completeness: '${party}' appears in the contract but has no actions or benefits.`);
    } else if (!receives) {
      warnings.push(`Party completeness: '${party}' sends tokens but never receives any. Likely incomplete.`);
    } else if (!sends) {
      warnings.push(`Party completeness: '${party}' only receives tokens; no outgoing obligations.`);
    }
  }

  return { isValid: errors.length === 0, errors, warnings, facts };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addFact(map, key, value) {
  if (!map[key]) map[key] = new Set();
  map[key].add(value);
}

function serializeSets(map) {
  const result = {};
  for (const [k, v] of Object.entries(map)) result[k] = [...v];
  return result;
}

module.exports = { analyse };
