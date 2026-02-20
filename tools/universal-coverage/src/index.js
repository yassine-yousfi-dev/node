const fs = require('fs');
const { execSync } = require('child_process');
const { parseJacoco } = require('./adapters/jacoco');
const { parseLcov } = require('./adapters/lcov');
const { parseC8 } = require('./adapters/c8');
const { loadJson, saveJson, ensureDir } = require('./lib/io');
const { prDiffToChangedRanges } = require('./lib/diff');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v =
        argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[k] = v;
    }
  }
  return args;
}

function parseCoverage(format, coveragePath) {
  if (!fs.existsSync(coveragePath)) return new Map();
  if (format === 'jacoco') return parseJacoco(coveragePath);
  if (format === 'lcov') return parseLcov(coveragePath);
  if (format === 'c8') return parseC8(coveragePath);
  throw new Error(`Unsupported format: ${format}`);
}

/**
 * Universal schema:
 * {
 *   "tests":[
 *     { "id":"TestName", "type":"unknown",
 *       "files":[ {"path":"x","lines":[1,2,3]} ]
 *     }
 *   ]
 * }
 */
function mergeIntoUniversal(universal, testId, fileToLines) {
  const files = [];
  for (const [p, linesSet] of fileToLines.entries()) {
    files.push({ path: p, lines: Array.from(linesSet).sort((a, b) => a - b) });
  }
  universal.tests.push({ id: testId, type: 'unknown', files });
}

async function cmdMap(args) {
  const format = args.format;
  const coveragePath = args.coverage;
  const outPath = args.out;

  const testListCmd = args['test-list'];
  const testRunTemplate = args['test-run'];

  if (
    !format ||
    !coveragePath ||
    !outPath ||
    !testListCmd ||
    !testRunTemplate
  ) {
    throw new Error(
      'map requires --format --coverage --out --test-list --test-run',
    );
  }

  // Get tests (one per line)
  const testList = execSync(testListCmd, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const universal = { tests: [] };

  for (const testId of testList) {
    const cmd = testRunTemplate.replaceAll('{{TEST}}', testId);
    console.log(`\n=== Running test: ${testId} ===\n${cmd}\n`);
    execSync(cmd, { stdio: 'inherit' });

    const fileToLines = parseCoverage(format, coveragePath);
    mergeIntoUniversal(universal, testId, fileToLines);
  }

  ensureDir(outPath);
  saveJson(outPath, universal);
  console.log(`\nWrote universal map: ${outPath}`);
}

function intersectsChangedRanges(fileEntry, changedRanges) {
  // changedRanges: Map<path, Array<[start,end]>>
  const ranges = changedRanges.get(fileEntry.path);
  if (!ranges || ranges.length === 0) return false;

  // If no lines recorded, treat file-level match
  if (!fileEntry.lines || fileEntry.lines.length === 0) return true;

  // Check any covered line is in any changed range
  for (const line of fileEntry.lines) {
    for (const [s, e] of ranges) {
      if (line >= s && line <= e) return true;
    }
  }
  return false;
}

function cmdSelect(args) {
  const mapPath = args.map;
  const prPath = args.pr;
  const outPath = args.out;

  if (!mapPath || !prPath || !outPath) {
    throw new Error('select requires --map --pr --out');
  }

  const universal = loadJson(mapPath);
  const prFiles = loadJson(prPath); // [{filename, patch}...]

  const changedRanges = prDiffToChangedRanges(prFiles);

  const selected = [];
  for (const t of universal.tests || []) {
    const hit = (t.files || []).some((f) =>
      intersectsChangedRanges(f, changedRanges),
    );
    if (hit) selected.push(t.id);
  }

  fs.writeFileSync(
    outPath,
    selected.join('\n') + (selected.length ? '\n' : ''),
    'utf8',
  );
  console.log(`Selected ${selected.length} test(s). Wrote: ${outPath}`);
}

(async function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  try {
    if (cmd === 'map') return await cmdMap(args);
    if (cmd === 'select') return cmdSelect(args);
    console.log('Usage:');
    console.log(
      '  node src/index.js map --format lcov|jacoco --coverage <path> --test-list <cmd> --test-run <cmdTemplate> --out <json>',
    );
    console.log(
      '  node src/index.js select --map <json> --pr <pr_files.json> --out <selected_tests.txt>',
    );
    process.exit(1);
  } catch (e) {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  }
})();
