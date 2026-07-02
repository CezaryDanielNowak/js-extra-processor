#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function formatBytes(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatPercent(saved, original) {
  if (original <= 0) return '0.000%';
  return `${((saved / original) * 100).toFixed(3)}%`;
}

function main() {
  const rootDir = __dirname;
  const inputFile = path.resolve(rootDir, process.argv[2] || 'widget-v1-en-before.js');
  const compressor = path.resolve(rootDir, 'extra-compress.js');

  if (!fs.existsSync(inputFile)) {
    process.stderr.write(`Input file not found: ${inputFile}\n`);
    process.exit(1);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-extra-compressor-gains-'));
  const outputFile = path.join(tempDir, 'output.js');
  const reportFile = path.join(tempDir, 'report.json');

  const run = spawnSync(process.execPath, [
    compressor,
    inputFile,
    outputFile,
    '--report',
    reportFile
  ], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  if (run.status !== 0) {
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    process.exit(run.status || 1);
  }

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const before = report.before;
  const savings = report.savings;

  process.stdout.write([
    `Example input file: ${formatBytes(before.raw)} bytes`,
    '',
    `Raw saving: ${formatBytes(savings.raw)} bytes / ${formatPercent(savings.raw, before.raw)}`,
    `Gzip saving: ${formatBytes(savings.gzip)} bytes / ${formatPercent(savings.gzip, before.gzip)}`,
    `Brotli saving: ${formatBytes(savings.brotli)} bytes / ${formatPercent(savings.brotli, before.brotli)}`,
    ''
  ].join('\n'));
}

main();