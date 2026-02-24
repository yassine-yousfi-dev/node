const fs = require('fs');
const { execSync } = require('child_process');
const { parseJacoco } = require('./adapters/jacoco');
const { parseLcov } = require('./adapters/lcov');
const { parseC8 } = require('./adapters/c8');
const { loadJson, saveJson, ensureDir } = require('./lib/io');
const { prDiffToChangedRanges } = require('./lib/diff');
const { discoverTestSetup } = require('./lib/discovery');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const hasNextValue =
        i + 1 < argv.length && !argv[i + 1].startsWith('--');
      const v = hasNextValue ? argv[++i] : 'true';
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

function buildUniversalTestEntry(testId, fileToLines) {
  const files = [];
  for (const [p, linesSet] of fileToLines.entries()) {
    files.push({ path: p, lines: Array.from(linesSet).sort((a, b) => a - b) });
  }
  return { id: testId, type: 'unknown', files };
}

async function cmdMap(args) {
  const format = args.format;
  const coveragePath = args.coverage;
  const outPath = args.out;
  const continueOnTestFailure = args['continue-on-test-failure'] === 'true';
  const autoDiscoverTests = args['auto-discover-tests'] === 'true';

  let testListCmd = args['test-list'];
  let testRunTemplate = args['test-run'];

  if ((!testListCmd || !testRunTemplate) && autoDiscoverTests) {
    const detected = discoverTestSetup();
    testListCmd = testListCmd || detected.test_list_command;
    testRunTemplate = testRunTemplate || detected.test_run_command_template;
    console.log(
      `Auto-discovered test setup: ${detected.adapter} (${detected.source}, confidence=${detected.confidence})`,
    );
    if (Array.isArray(detected.warnings)) {
      for (const w of detected.warnings) console.warn(w);
    }
  }

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

  const failedTests = [];
  let mappedCount = 0;
  let wroteAnyEntry = false;
  let writeCompleted = false;

  ensureDir(outPath);
  const outFd = fs.openSync(outPath, 'w');
  fs.writeSync(outFd, '{"tests":[\n');

  try {
    for (const testId of testList) {
      const cmd = testRunTemplate.replaceAll('{{TEST}}', testId);
      console.log(`\n=== Running test: ${testId} ===\n${cmd}\n`);
      try {
        execSync(cmd, { stdio: 'inherit' });
      } catch (err) {
        if (!continueOnTestFailure) throw err;
        failedTests.push(testId);
        console.warn(`Skipping failed test in map generation: ${testId}`);
        continue;
      }

      const fileToLines = parseCoverage(format, coveragePath);
      const entry = buildUniversalTestEntry(testId, fileToLines);
      if (wroteAnyEntry) fs.writeSync(outFd, ',\n');
      fs.writeSync(outFd, JSON.stringify(entry));
      wroteAnyEntry = true;
      mappedCount += 1;
    }
    fs.writeSync(outFd, '\n]}\n');
    writeCompleted = true;
  } finally {
    fs.closeSync(outFd);
    if (!writeCompleted) {
      fs.rmSync(outPath, { force: true });
    }
  }

  console.log(`\nWrote universal map: ${outPath} (${mappedCount} test entries)`);
  if (failedTests.length > 0) {
    console.warn(
      `Map generated with ${failedTests.length} failed test(s) skipped.`,
    );
  }
}

function cmdDiscover(args) {
  const outPath = args.out;
  const detected = discoverTestSetup();
  const payload = {
    adapter: detected.adapter,
    source: detected.source,
    confidence: detected.confidence,
    test_list_command: detected.test_list_command,
    test_run_command_template: detected.test_run_command_template,
    warnings: detected.warnings || [],
  };

  if (outPath) {
    ensureDir(outPath);
    saveJson(outPath, payload);
  }
  console.log(JSON.stringify(payload, null, 2));
}

function intersectsChangedRanges(fileEntry, changedRanges) {
  // changedRanges: Map<path, Array<[start,end]>>
  const ranges = getChangedRangesForPath(changedRanges, fileEntry.path);
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

function normalizePathForMatch(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

const normalizedChangedRangesCache = new WeakMap();

function getChangedRangesForPath(changedRanges, filePath) {
  const normalizedFilePath = normalizePathForMatch(filePath);

  // 1) Fast exact (normalized) match
  let normalized = normalizedChangedRangesCache.get(changedRanges);
  if (normalized == null) {
    const normalizedMap = new Map();
    for (const [k, v] of changedRanges.entries()) {
      normalizedMap.set(normalizePathForMatch(k), v);
    }
    normalizedChangedRangesCache.set(changedRanges, normalizedMap);
    normalized = normalizedChangedRangesCache.get(changedRanges);
  }
  const direct = normalized.get(normalizedFilePath);
  if (direct) return direct;

  // 2) Fallback for absolute-vs-relative mismatches:
  // map path ".../repo/lib/x.js" should match PR path "lib/x.js".
  let bestKey = null;
  for (const k of normalized.keys()) {
    if (
      normalizedFilePath === k ||
      normalizedFilePath.endsWith(`/${k}`)
    ) {
      if (bestKey == null || k.length > bestKey.length) bestKey = k;
    }
  }
  if (bestKey) return normalized.get(bestKey);
  return null;
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
  console.log(
    `Selection input: ${prFiles.length} changed file(s), ${(universal.tests || []).length} mapped test(s).`,
  );

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
    if (cmd === 'discover') return cmdDiscover(args);
    if (cmd === 'select') return cmdSelect(args);
    console.log('Usage:');
    console.log(
      '  node src/index.js map --format c8|lcov|jacoco --coverage <path> --test-list <cmd> --test-run <cmdTemplate> [--auto-discover-tests true] [--continue-on-test-failure true] --out <json>',
    );
    console.log(
      '  node src/index.js discover [--out <json>]',
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
