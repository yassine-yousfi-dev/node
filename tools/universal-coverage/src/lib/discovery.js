const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

function readTextIfExists(p) {
  if (!exists(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function detectNodePackage(cwd) {
  const pkg = readJsonIfExists(path.join(cwd, 'package.json'));
  if (!pkg) return null;
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  const scripts = pkg.scripts || {};
  const scriptsBlob = Object.values(scripts).join('\n');
  return { pkg, deps, scripts, scriptsBlob };
}

function hasAnyFile(cwd, names) {
  return names.some((name) => exists(path.join(cwd, name)));
}

function hasJavaTestSources(cwd) {
  return hasAnyFile(cwd, [
    'src/test/java',
    'src/test/kotlin',
    'src/test/groovy',
  ]);
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
    required_commands: ['python3', 'npx'],
    test_list_command:
      "find test -type f \\( -name 'test-*.js' -o -name 'test-*.mjs' \\) ! -path '*/fixtures/*' | sed -E 's#^test/##; s#\\.(mjs|js)$##' | sort",
    test_run_command_template:
      'rm -rf "coverage/tmp-{{WORKER}}" "{{COVERAGE_PATH}}" && mkdir -p "coverage/tmp-{{WORKER}}" "$(dirname "{{COVERAGE_PATH}}")" && NODE_V8_COVERAGE="coverage/tmp-{{WORKER}}" python3 tools/test.py --mode=release --type=coverage -j1 {{TEST}} && npx c8 report --reporter=json --report-dir="$(dirname "{{COVERAGE_PATH}}")" --temp-directory="coverage/tmp-{{WORKER}}"',
  };
}

function detectJest(cwd) {
  const nodePkg = detectNodePackage(cwd);
  if (!nodePkg) return null;

  const { deps, scriptsBlob } = nodePkg;
  const hasJestConfig =
    hasAnyFile(cwd, [
      'jest.config.js',
      'jest.config.cjs',
      'jest.config.mjs',
      'jest.config.ts',
    ]);

  const usesJest =
    Object.prototype.hasOwnProperty.call(deps, 'jest') ||
    /\bjest\b/.test(scriptsBlob) ||
    hasJestConfig;
  if (!usesJest) return null;

  return {
    adapter: 'jest',
    source: 'runner-native',
    confidence: 0.9,
    required_commands: ['npx'],
    test_list_command: 'npx jest --listTests',
    test_run_command_template:
      'rm -rf "coverage/tmp-{{WORKER}}" "{{COVERAGE_PATH}}" && mkdir -p "coverage/tmp-{{WORKER}}" "$(dirname "{{COVERAGE_PATH}}")" && NODE_V8_COVERAGE="coverage/tmp-{{WORKER}}" npx jest --runInBand {{TEST}} && npx c8 report --reporter=json --report-dir="$(dirname "{{COVERAGE_PATH}}")" --temp-directory="coverage/tmp-{{WORKER}}"',
  };
}

function detectVitest(cwd) {
  const nodePkg = detectNodePackage(cwd);
  if (!nodePkg) return null;

  const { deps, scriptsBlob } = nodePkg;
  const hasVitestConfig = hasAnyFile(cwd, [
    'vitest.config.js',
    'vitest.config.cjs',
    'vitest.config.mjs',
    'vitest.config.ts',
  ]);

  const usesVitest =
    Object.prototype.hasOwnProperty.call(deps, 'vitest') ||
    /\bvitest\b/.test(scriptsBlob) ||
    hasVitestConfig;
  if (!usesVitest) return null;

  return {
    adapter: 'vitest',
    source: 'runner-native',
    confidence: 0.85,
    required_commands: ['npx'],
    test_list_command: 'npx vitest list',
    test_run_command_template:
      'rm -rf "coverage/tmp-{{WORKER}}" "{{COVERAGE_PATH}}" && mkdir -p "coverage/tmp-{{WORKER}}" "$(dirname "{{COVERAGE_PATH}}")" && NODE_V8_COVERAGE="coverage/tmp-{{WORKER}}" npx vitest run {{TEST}} && npx c8 report --reporter=json --report-dir="$(dirname "{{COVERAGE_PATH}}")" --temp-directory="coverage/tmp-{{WORKER}}"',
    warnings: [
      'Vitest listing output can vary by version/config; validate test IDs in your environment.',
    ],
  };
}

function detectPytestProject(cwd) {
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
    required_commands: ['pytest'],
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
    required_commands: ['go'],
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
    required_commands: ['cargo'],
    test_list_command: "cargo test -- --list | sed 's/: test$//' | sed '/^$/d'",
    test_run_command_template:
      'cargo test {{TEST}} -- --exact && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'Rust discovery detected; map generation may require a custom coverage conversion pipeline.',
    ],
  };
}

function detectDotnet(cwd) {
  const hasCsproj = (() => {
    try {
      return fs.readdirSync(cwd).some((f) => f.endsWith('.sln') || f.endsWith('.csproj'));
    } catch {
      return false;
    }
  })();
  if (!hasCsproj) return null;
  return {
    adapter: 'dotnet-test',
    source: 'runner-native',
    confidence: 0.5,
    required_commands: ['dotnet'],
    test_list_command: 'dotnet test --list-tests',
    test_run_command_template:
      'dotnet test --filter "FullyQualifiedName={{TEST}}" && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'dotnet test --list-tests output and test filter format can vary by test framework.',
    ],
  };
}

function detectBazel(cwd) {
  const hasBazel = hasAnyFile(cwd, ['WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel']);
  if (!hasBazel) return null;
  return {
    adapter: 'bazel-test',
    source: 'runner-native',
    confidence: 0.45,
    required_commands: ['bazel'],
    test_list_command: 'bazel query "kind(test, //...)"',
    test_run_command_template:
      'bazel test {{TEST}} && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'Bazel test labels are not file paths; ensure downstream mapping treats labels as test IDs.',
    ],
  };
}

function detectMavenJUnitMockito(cwd) {
  const pomPath = path.join(cwd, 'pom.xml');
  const pomText = readTextIfExists(pomPath);
  if (!pomText) return null;

  const hasJunitOrMockito =
    /junit/i.test(pomText) || /mockito/i.test(pomText);
  if (!hasJunitOrMockito && !hasJavaTestSources(cwd)) return null;

  return {
    adapter: 'maven-junit',
    source: 'runner-native',
    confidence: hasJunitOrMockito ? 0.75 : 0.65,
    required_commands: ['mvn'],
    test_list_command:
      "find src/test -type f \\( -name '*Test.java' -o -name '*Tests.java' -o -name '*IT.java' -o -name '*Test.kt' -o -name '*Tests.kt' -o -name '*IT.kt' -o -name '*Test.groovy' -o -name '*Tests.groovy' -o -name '*IT.groovy' \\) | sed -E 's#^src/test/(java|kotlin|groovy)/##; s#/#.#g; s#\\.(java|kt|groovy)$##' | sort -u",
    test_run_command_template:
      'mvn -q -Dtest={{TEST}} test && echo "Configure coverage export for lcov/c8/jacoco compatibility."',
    warnings: [
      'Maven test detection uses class-name discovery from src/test; nested/parameterized naming may require custom --test-list.',
    ],
  };
}

function detectGradleJUnitMockito(cwd) {
  const gradleFiles = [
    path.join(cwd, 'build.gradle'),
    path.join(cwd, 'build.gradle.kts'),
    path.join(cwd, 'settings.gradle'),
    path.join(cwd, 'settings.gradle.kts'),
  ];
  const gradleText = gradleFiles
    .map((p) => readTextIfExists(p) || '')
    .join('\n');
  const hasGradleSignal =
    gradleText.trim().length > 0 ||
    hasAnyFile(cwd, ['gradlew', 'gradlew.bat']);
  if (!hasGradleSignal) return null;

  const hasJunitOrMockito =
    /junit/i.test(gradleText) || /mockito/i.test(gradleText);
  if (!hasJunitOrMockito && !hasJavaTestSources(cwd)) return null;

  const gradleCmd = hasAnyFile(cwd, ['gradlew', 'gradlew.bat'])
    ? './gradlew'
    : 'gradle';

  return {
    adapter: 'gradle-junit',
    source: 'runner-native',
    confidence: hasJunitOrMockito ? 0.72 : 0.62,
    required_commands: hasAnyFile(cwd, ['gradlew', 'gradlew.bat'])
      ? []
      : ['gradle'],
    test_list_command:
      "find src/test -type f \\( -name '*Test.java' -o -name '*Tests.java' -o -name '*IT.java' -o -name '*Test.kt' -o -name '*Tests.kt' -o -name '*IT.kt' -o -name '*Test.groovy' -o -name '*Tests.groovy' -o -name '*IT.groovy' \\) | sed -E 's#^src/test/(java|kotlin|groovy)/##; s#/#.#g; s#\\.(java|kt|groovy)$##' | sort -u",
    test_run_command_template:
      `${gradleCmd} test --tests "{{TEST}}" && echo "Configure coverage export for lcov/c8/jacoco compatibility."`,
    warnings: [
      'Gradle test detection uses class-name discovery from src/test; custom source sets may require custom --test-list.',
    ],
  };
}

function detectPytest(cwd) {
  return detectPytestProject(cwd);
}

function heuristicFallback() {
  return {
    adapter: 'heuristic-fallback',
    source: 'heuristic',
    confidence: 0.2,
    required_commands: ['find', 'sed', 'sort'],
    test_list_command:
      "find . -type f \\( -name '*_test.*' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test-*.js' -o -name 'test_*.py' \\) | sed 's#^\\./##' | sort",
    test_run_command_template:
      'echo "No verified runner detected for {{TEST}}. Provide --test-run explicitly." && exit 1',
    warnings: [
      'Using heuristic fallback; this is less reliable than runner-native discovery.',
    ],
  };
}

function commandExists(command, cwd) {
  const check = process.platform === 'win32'
    ? `where ${command}`
    : `command -v ${command}`;
  try {
    execSync(check, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function probeCandidate(candidate, options = {}) {
  const cwd = options.cwd || process.cwd();
  const requiredCommands = Array.isArray(candidate.required_commands)
    ? candidate.required_commands
    : [];

  const missingCommands = requiredCommands.filter((cmd) => !commandExists(cmd, cwd));
  const probe = {
    checked: true,
    commands_ok: missingCommands.length === 0,
    missing_commands: missingCommands,
  };

  let score = candidate.confidence;
  if (missingCommands.length > 0) score -= 0.5;
  else score += 0.1;

  return {
    ...candidate,
    probe,
    score,
  };
}

function createDetectorList() {
  return [
    detectNodeCoreRepo,
    detectJest,
    detectVitest,
    detectPytest,
    detectGo,
    detectRust,
    detectMavenJUnitMockito,
    detectGradleJUnitMockito,
    detectDotnet,
    detectBazel,
  ];
}

function discoverAllTestSetups(options = {}) {
  const cwd = options.cwd || process.cwd();
  const shouldProbe = options.probe !== false;
  const candidates = [];

  const detectors = createDetectorList();
  for (const detect of detectors) {
    const result = detect(cwd);
    if (result) candidates.push(result);
  }

  if (candidates.length === 0) {
    const fallback = heuristicFallback();
    return [shouldProbe ? probeCandidate(fallback, { cwd }) : fallback];
  }

  const evaluated = shouldProbe
    ? candidates.map((candidate) => probeCandidate(candidate, { cwd }))
    : candidates.map((candidate) => ({ ...candidate, score: candidate.confidence }));

  evaluated.sort((a, b) => b.score - a.score);
  return evaluated;
}

function discoverTestSetup(options = {}) {
  const all = discoverAllTestSetups(options);
  return all[0];
}

module.exports = { discoverTestSetup, discoverAllTestSetups };
