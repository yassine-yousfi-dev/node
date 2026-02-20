const fs = require("fs");
const xml2js = require("xml2js");

/**
 * Returns Map<filePath, Set<coveredLines>>
 * Note: JaCoCo XML gives line coverage per source file (not per test by itself).
 * Per-test mapping comes from running one test at a time (map-builder workflow).
 */
function parseJacoco(jacocoXmlPath) {
  const xml = fs.readFileSync(jacocoXmlPath, "utf8");
  let parsed = null;

  xml2js.parseString(xml, { explicitArray: false }, (err, res) => {
    if (err) throw err;
    parsed = res;
  });

  const out = new Map();
  const report = parsed?.report;
  const packages = report?.package
    ? Array.isArray(report.package)
      ? report.package
      : [report.package]
    : [];

  for (const pkg of packages) {
    const srcFiles = pkg?.sourcefile
      ? Array.isArray(pkg.sourcefile)
        ? pkg.sourcefile
        : [pkg.sourcefile]
      : [];

    for (const sf of srcFiles) {
      const filename = sf?.$?.name; // e.g., Checkout.java
      const lines = sf?.line
        ? Array.isArray(sf.line)
          ? sf.line
          : [sf.line]
        : [];
      const covered = new Set();

      for (const ln of lines) {
        const nr = Number(ln?.$?.nr);
        const ci = Number(ln?.$?.ci || 0); // covered instructions
        if (Number.isFinite(nr) && ci > 0) covered.add(nr);
      }

      // Store by filename (or optionally include package path; keep MVP simple)
      if (!out.has(filename)) out.set(filename, new Set());
      const existing = out.get(filename);
      for (const l of covered) existing.add(l);
    }
  }

  return out;
}

module.exports = { parseJacoco };
