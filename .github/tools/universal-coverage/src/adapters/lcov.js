const fs = require("fs");

/**
 * Returns Map<filePath, Set<coveredLines>>
 * Parses DA:<line>,<hits> entries.
 */
function parseLcov(lcovPath) {
  const txt = fs.readFileSync(lcovPath, "utf8");
  const out = new Map();

  let currentFile = null;
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
      if (!out.has(currentFile)) out.set(currentFile, new Set());
    } else if (line.startsWith("DA:") && currentFile) {
      const [lnStr, hitsStr] = line.slice(3).split(",");
      const ln = Number(lnStr);
      const hits = Number(hitsStr);
      if (Number.isFinite(ln) && hits > 0) out.get(currentFile).add(ln);
    } else if (line === "end_of_record") {
      currentFile = null;
    }
  }

  return out;
}

module.exports = { parseLcov };
