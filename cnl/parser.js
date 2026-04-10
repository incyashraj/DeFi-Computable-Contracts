'use strict';

// ── Tokenizer ─────────────────────────────────────────────────────────────────
//
// Breaks a single CNL sentence into a stream of typed tokens.
// Commas are normalised to their own token so the grammar rules can treat
// "if <cond>, <action>" uniformly.

function tokenize(text) {
  const tokens = [];
  const normalised = text.replace(/,\s*/g, ' , ');
  for (const raw of normalised.trim().split(/\s+/)) {
    if (!raw) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) {
      tokens.push({ type: 'NUMBER', value: raw });
    } else if (raw === ',') {
      tokens.push({ type: 'COMMA', value: ',' });
    } else {
      tokens.push({ type: 'WORD', value: raw.toLowerCase(), raw });
    }
  }
  tokens.push({ type: 'EOF' });
  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────────
//
// Recursive-descent parser over the token stream.
//
// Supported production rules:
//
//   clause :=
//     | party "locks" amount token "as collateral" ["for" party]
//     | party "transfers" amount token "to" party ["as premium"]
//     | party "receives" amount token "from" party
//     | party "must" verb amount token "to" party "within" duration
//     | party "may exercise option to receive" amount token "for" amount token ["within" duration]
//     | "if" price_condition "," "trigger margin call requiring" amount token ["top-up"] "within" duration
//     | "if" price_condition "," party "receives" amount token "from" party
//     | "if" price_condition "," party "transfers" amount token "to" party
//
//   price_condition :=
//     | "price of" token "falls below" number "USD"
//     | "price of" token "rises above" number "USD"
//
//   duration := number ("seconds"|"minutes"|"hours"|"days"|"weeks")

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos    = 0;
  }

  peek()  { return this.tokens[this.pos]; }
  next()  { return this.tokens[this.pos++]; }

  is(val) {
    const t = this.peek();
    if (val === ',')   return t.type === 'COMMA';
    if (val === 'EOF') return t.type === 'EOF';
    return t.type === 'WORD' && t.value === val.toLowerCase();
  }

  eat(val) {
    if (this.is(val)) { this.next(); return true; }
    return false;
  }

  expect(val) {
    if (!this.eat(val)) {
      const found = this.peek().value || this.peek().type;
      throw new Error(`Expected '${val}', found '${found}' (position ${this.pos})`);
    }
  }

  parseParty() {
    if (this.is('party')) {
      this.next();
      const t = this.next();
      return `Party ${(t.raw || t.value).toUpperCase()}`;
    }
    const t = this.next();
    return t.raw || t.value;
  }

  parseNumber() {
    const t = this.peek();
    if (t.type !== 'NUMBER')
      throw new Error(`Expected a number, found '${t.value || t.type}'`);
    return this.next().value;
  }

  parseSymbol() {
    // Token symbol — one WORD, returned in uppercase (e.g. "weth" → "WETH").
    const t = this.next();
    if (t.type !== 'WORD')
      throw new Error(`Expected token symbol, found '${t.value || t.type}'`);
    return (t.raw || t.value).toUpperCase();
  }

  parseDuration() {
    const amount = this.parseNumber();
    const t      = this.next();
    const UNITS  = ['second','seconds','minute','minutes','hour','hours','day','days','week','weeks'];
    if (!UNITS.includes(t.value))
      throw new Error(`Expected a time unit, found '${t.value}'`);
    const unit = t.value.endsWith('s') ? t.value : t.value + 's';
    return { amount, unit };
  }

  parsePriceCondition() {
    this.expect('price');
    this.expect('of');
    const token = this.parseSymbol();
    if (this.is('falls')) {
      this.next(); this.expect('below');
      const price = this.parseNumber();
      this.eat('usd');
      return { type: 'PriceBelow', token, price };
    }
    if (this.is('rises')) {
      this.next(); this.expect('above');
      const price = this.parseNumber();
      this.eat('usd');
      return { type: 'PriceAbove', token, price };
    }
    throw new Error(`Expected 'falls below' or 'rises above' after price token`);
  }

  parseClause() {
    // ── Conditional clauses ──────────────────────────────────────────────────
    if (this.is('if')) {
      this.next();
      const condition = this.parsePriceCondition();
      this.expect(',');

      // "trigger margin call requiring X TOKEN [top-up] within <duration>"
      if (this.is('trigger')) {
        this.next();
        this.expect('margin');
        this.expect('call');
        this.expect('requiring');
        const topUpAmount = this.parseNumber();
        const topUpToken  = this.parseSymbol();
        this.eat('top-up');
        this.expect('within');
        const deadline = this.parseDuration();
        return { type: 'MarginCall', condition, topUpAmount, topUpToken, deadline };
      }

      // "Party X receives/transfers ..."
      const party = this.parseParty();
      if (this.is('receives')) {
        this.next();
        const amount = this.parseNumber();
        const token  = this.parseSymbol();
        this.expect('from');
        const from = this.parseParty();
        return { type: 'ConditionalTransfer', condition, from, amount, token, to: party };
      }
      if (this.is('transfers')) {
        this.next();
        const amount = this.parseNumber();
        const token  = this.parseSymbol();
        this.expect('to');
        const to = this.parseParty();
        return { type: 'ConditionalTransfer', condition, from: party, amount, token, to };
      }
      throw new Error(`Unexpected '${this.peek().value}' after conditional and party`);
    }

    // ── Party-initiated clauses ──────────────────────────────────────────────
    const party = this.parseParty();

    // Party A locks X TOKEN as collateral [for Party B]
    if (this.is('locks')) {
      this.next();
      const amount = this.parseNumber();
      const token  = this.parseSymbol();
      this.expect('as');
      this.expect('collateral');
      let forParty = null;
      if (this.eat('for')) forParty = this.parseParty();
      return { type: 'CollateralLock', party, amount, token, forParty };
    }

    // Party A transfers X TOKEN to Party B [as premium]
    if (this.is('transfers')) {
      this.next();
      const amount = this.parseNumber();
      const token  = this.parseSymbol();
      this.expect('to');
      const to = this.parseParty();
      let asPremium = false;
      if (this.eat('as')) { this.eat('premium'); asPremium = true; }
      return { type: 'Transfer', from: party, amount, token, to, asPremium };
    }

    // Party A receives X TOKEN from Party B (equivalent to a Transfer from B to A)
    if (this.is('receives')) {
      this.next();
      const amount = this.parseNumber();
      const token  = this.parseSymbol();
      this.expect('from');
      const from = this.parseParty();
      return { type: 'Transfer', from, amount, token, to: party };
    }

    // Party A must (repay|transfer|pay) X TOKEN to Party B within <duration>
    if (this.is('must')) {
      this.next();
      const verb   = this.next().value;
      const amount = this.parseNumber();
      const token  = this.parseSymbol();
      this.expect('to');
      const to     = this.parseParty();
      this.expect('within');
      const deadline = this.parseDuration();
      return { type: 'Obligation', party, verb, amount, token, to, deadline };
    }

    // Party A may exercise option to receive X TOKEN for Y TOKEN [within <duration>]
    if (this.is('may')) {
      this.next();
      this.expect('exercise');
      this.expect('option');
      this.expect('to');
      this.expect('receive');
      const receiveAmount = this.parseNumber();
      const receiveToken  = this.parseSymbol();
      this.expect('for');
      const giveAmount = this.parseNumber();
      const giveToken  = this.parseSymbol();
      let expiry = null;
      if (this.eat('within') || this.eat('before') || this.eat('by')) {
        expiry = this.parseDuration();
      }
      return { type: 'Option', holder: party, receiveAmount, receiveToken, giveAmount, giveToken, expiry };
    }

    const found = this.peek().value || this.peek().type;
    throw new Error(`Cannot parse clause for party '${party}'; unexpected '${found}'`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
//
// Splits text into sentences (one clause per line, trailing period optional),
// parses each, and returns a combined AST with metadata.

function parse(text) {
  const clauses  = [];
  const errors   = [];
  const partySet = new Set();
  const tokenSet = new Set();

  const sentences = text
    .split('\n')
    .map(s => s.replace(/\.\s*$/, '').trim())
    .filter(s => s && !s.startsWith('//') && !s.startsWith('#'));

  for (const sentence of sentences) {
    try {
      const toks   = tokenize(sentence);
      const parser = new Parser(toks);
      const clause = parser.parseClause();
      collectParties(clause, partySet);
      collectSymbols(clause, tokenSet);
      clauses.push({ ...clause, source: sentence });
    } catch (err) {
      errors.push({ sentence, message: err.message });
    }
  }

  return {
    clauses,
    parties: [...partySet],
    tokens:  [...tokenSet],
    errors,
  };
}

function collectParties(node, set) {
  for (const f of ['party', 'from', 'to', 'forParty', 'holder']) {
    if (typeof node[f] === 'string' && node[f].startsWith('Party ')) set.add(node[f]);
  }
}

function collectSymbols(node, set) {
  for (const f of ['token', 'topUpToken', 'receiveToken', 'giveToken']) {
    if (typeof node[f] === 'string') set.add(node[f]);
  }
  if (node.condition && node.condition.token) set.add(node.condition.token);
}

module.exports = { parse, tokenize };
