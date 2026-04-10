#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const { parse    } = require('./parser');
const { analyse  } = require('./datalog');
const { compile  } = require('./compiler');

// ── CLI ───────────────────────────────────────────────────────────────────────
//
// Usage:
//   node cnl/cli.js <file.cnl>            — parse + analyse
//   node cnl/cli.js <file.cnl> --compile  — parse + analyse + emit Solidity

const [, , inputFile, flag] = process.argv;

if (!inputFile || inputFile === '--help' || inputFile === '-h') {
  console.log('Usage: node cnl/cli.js <file.cnl> [--compile]');
  console.log('');
  console.log('  <file.cnl>   Path to a CNL clause file (one clause per line)');
  console.log('  --compile    Also emit a Solidity contract to <file>.sol');
  process.exit(0);
}

const inputPath = path.resolve(inputFile);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const text = fs.readFileSync(inputPath, 'utf8');
const baseName     = path.basename(inputPath, '.cnl');
const contractName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

// 1. Parse ────────────────────────────────────────────────────────────────────

const ast = parse(text);

console.log(`\n── Parsed ${ast.clauses.length} clause(s) from ${path.basename(inputPath)} ──`);
for (const clause of ast.clauses) {
  console.log(`  [${clause.type.padEnd(20)}]  ${clause.source}.`);
}

if (ast.errors.length > 0) {
  console.log(`\n── Parse errors (${ast.errors.length}) ──`);
  for (const e of ast.errors) {
    console.error(`  ✗  ${e.message}`);
    console.error(`     in: "${e.sentence}"`);
  }
  process.exit(1);
}

// 2. Datalog analysis ─────────────────────────────────────────────────────────

const result = analyse(ast);

if (result.errors.length > 0) {
  console.log(`\n── Analysis errors (${result.errors.length}) ──`);
  for (const e of result.errors) console.error(`  ✗  ${e}`);
}

if (result.warnings.length > 0) {
  console.log(`\n── Analysis warnings (${result.warnings.length}) ──`);
  for (const w of result.warnings) console.log(`  ⚠  ${w}`);
}

if (result.isValid && result.warnings.length === 0) {
  console.log('\n── Analysis: OK — no issues found ──');
} else if (result.isValid) {
  console.log('\n── Analysis: PASS with warnings ──');
} else {
  console.log('\n── Analysis: FAIL ──');
}

// 3. Compile ──────────────────────────────────────────────────────────────────

if (flag === '--compile' || flag === '-c') {
  const generated  = compile(ast, contractName);
  const outputDir  = path.join(path.dirname(inputPath), '..', 'src', 'generated');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${contractName}.sol`);
  fs.writeFileSync(outputPath, generated);
  console.log(`\n── Compiled → ${path.relative(process.cwd(), outputPath)} ──\n`);
  console.log(generated);
}
