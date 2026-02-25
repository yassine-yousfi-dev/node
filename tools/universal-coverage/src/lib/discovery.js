const fs = require('fs');
const path = require('path');

function exists(p) {
  return fs.existsSync(p);
}

function readJsonIfExists(p) {
  if (!exists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function detectNodeCoreRepo(cwd) {
  if (!exists(path.join(cwd, 'tools', 'test.py'))) return null;
  const hasTestTree =
    exists(path.join(cwd, 'test')) || exists(path.join(cwd, 'tests'));
  if (!hasTestTree) return null;

  return {
    adapter: 'node-core-tools-test',
    source: 'repo-specific',
    confidence: 1,
    test_list_command:
      "find test/parallel test/sequential -type f \\( -name 'test-*.js' -o -name 'test-*.mjs' \\) | sed -E 's#^test/##; s#\\.(mjs|js)$##' | sort",
    test_run_command_template:
      'rm -rf "coverage/tmp-{{WORKER}}" "{{COVERAGE_PATH}}" && mkdir -p "coverage/tmp-{{WORKER}}" "$(dirname "{{COVERAGE_PATH}}")" && NODE_V8_COVERAGE="coverage/tmp-{{WORKER}}" python3 tools/test.py --mode=release --type=coverage -j1 {{TEST}} && npx c8 report --reporter=json --report-dir="$(dirname "{{COVERAGE_PATH}}")" --temp-directory="coverage/tmp-{{WORKER}}"',
  };
}

function detectJest(cwd) {
  const pkg = readJsonIfExists(path.join(cwd, 'package.json'));
  if (!pkg) return null;

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  const scripts = pkg.scripts || {};
  const scriptsBlob = Object.values(scripts).join('\n');
  const hasJestConfig =
    exists(path.join(cwd, 'jest.config.js')) ||
    exists(path.join(cwd, 'jest.config.cjs')) ||
    exists(path.join(cwd, 'jest.config.mjs')) ||
    exists(path.join(cwd, 'jest.config.ts'));

  const usesJest =
    Object.prototype.hasOwnProperty.call(deps, 'jest') ||
    /\bjest\b/.test(scriptsBlob) ||
    hasJestConfig;
  if (!usesJest) return null;

  return {
    adapter: 'jest',
    source: 'runner-native',
    confidence: 0.9,
    test_list_command: 'npx jest --listTests',
    test_run_command_template:
      'rm -rf "coverage/tmp-{{WORKER}}" "{{COVERAGE_PATH}}" && mkdir -p "coverage/tmp-{{WORKER}}" "$(dirname "{{COVERAGE_PATH}}")" && NODE_V8_COVERAGE="coverage/tmp-{{WORKER}}" npx jest --runInBand {{TEST}} && npx c8 report --reporter=json --report-dir="$(dirname "{{COVERAGE_PATH}}")" --temp-directory="coverage/tmp-{{WORKER}}"',
  };
}

function detectPytest(cwd) {
  const hasSignal =
    exists(path.join(cwd, 'pytest.ini')) ||
    exists(path.join(cwd, 'tox.ini')) ||
    exists(path.join(cwd, 'setup.cfg')) ||
    exists(path.join(cwd, 'pyproject.toml'));
  if (!hasSignal) return null;

  return {
    adapter: 'pytest',
    source: 'runner-native',
    confidence: 0.7,
    test_list_command: 'pytest --collect-only -q',
    test_run_command_template:
      'pytest -q {{TEST}} && echo "Configure --coverage/--format for non-c8 adapters if needed."',
    warnings: [
      'Pytest discovery detected; coverage output format may require repository-specific configuration.',
    ],
  };
}

function detectGo(cwd) {
  if (!exists(path.join(cwd, 'go.mod'))) return null;
  return {
    adapter: 'go-test',
    source: 'runner-native',
    confidence: 0.6,
    test_list_command: "go test ./... -list . | sed '/^ok\\s/d'",
    test_run_command_template:
      'go test ./... -run "^{{TEST}}$" && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'Go discovery detected; map generation may require a custom coverage conversion pipeline.',
    ],
  };
}

function detectRust(cwd) {
  if (!exists(path.join(cwd, 'Cargo.toml'))) return null;
  return {
    adapter: 'cargo-test',
    source: 'runner-native',
    confidence: 0.6,
    test_list_command: "cargo test -- --list | sed 's/: test$//' | sed '/^$/d'",
    test_run_command_template:
      'cargo test {{TEST}} -- --exact && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'Rust discovery detected; map generation may require a custom coverage conversion pipeline.',
    ],
  };
}

function heuristicFallback() {
  return {
    adapter: 'heuristic-fallback',
    source: 'heuristic',
    confidence: 0.2,
    test_list_command:
      "find . -type f \\( -name '*_test.*' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test-*.js' -o -name 'test_*.py' \\) | sed 's#^\\./##' | sort",
    test_run_command_template:
      'echo "No verified runner detected for {{TEST}}. Provide --test-run explicitly." && exit 1',
    warnings: [
      'Using heuristic fallback; this is less reliable than runner-native discovery.',
    ],
  };
}

function discoverTestSetup(options = {}) {
  const cwd = options.cwd || process.cwd();
  const candidates = [];

  const detectors = [
    detectNodeCoreRepo,
    detectJest,
    detectPytest,
    detectGo,
    detectRust,
  ];

  for (const detect of detectors) {
    const result = detect(cwd);
    if (result) candidates.push(result);
  }

  if (candidates.length === 0) return heuristicFallback();
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

module.exports = { discoverTestSetup };
