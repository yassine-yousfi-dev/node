const fs = require('fs');

/**
 * c8 can emit Istanbul JSON at coverage/coverage-final.json
 * This adapter returns: Map<filePath, Set<coveredLines>>
 *
 * It marks a line as "covered" if any covered statement spans that line.
 */
function parseC8(istanbulJsonPath) {
  if (!fs.existsSync(istanbulJsonPath)) return new Map();

  const data = JSON.parse(fs.readFileSync(istanbulJsonPath, 'utf8'));
  const out = new Map();

  for (const [filePath, fc] of Object.entries(data)) {
    const covered = new Set();

    // statements coverage: fc.statementMap + fc.s (hit counts)
    const statementMap = fc.statementMap || {};
    const sCounts = fc.s || {};

    for (const [stmtId, loc] of Object.entries(statementMap)) {
      const hits = sCounts[stmtId] || 0;
      if (!hits) continue;

      const startLine = loc?.start?.line;
      const endLine = loc?.end?.line ?? startLine;
      if (!Number.isFinite(startLine)) continue;

      for (let ln = startLine; ln <= endLine; ln++) covered.add(ln);
    }

    // (Optional) also mark function lines as covered if function hit > 0
    const fnMap = fc.fnMap || {};
    const fCounts = fc.f || {};
    for (const [fnId, fnLoc] of Object.entries(fnMap)) {
      const hits = fCounts[fnId] || 0;
      if (!hits) continue;
      const ln = fnLoc?.loc?.start?.line;
      if (Number.isFinite(ln)) covered.add(ln);
    }

    out.set(filePath, covered);
  }

  return out;
}

module.exports = { parseC8 };
