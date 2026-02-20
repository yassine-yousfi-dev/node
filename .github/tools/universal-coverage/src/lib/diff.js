/**
 * Convert PR files (with unified diff patches) into changed line *ranges*.
 * We do range-based hunks (safe + simple): @@ -a,b +c,d @@ -> [c, c+d-1]
 *
 * Returns Map<path, Array<[start,end]>>
 */
function prDiffToChangedRanges(prFiles) {
  const out = new Map();

  for (const f of prFiles) {
    const filename = f.filename;
    const patch = f.patch;

    if (!out.has(filename)) out.set(filename, []);
    const ranges = out.get(filename);

    if (!patch) {
      // If we have no patch (binary/too large), treat whole file as changed.
      ranges.push([1, Number.MAX_SAFE_INTEGER]);
      continue;
    }

    const lines = patch.split("\n");
    for (const l of lines) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (l.startsWith("@@")) {
        const m = l.match(/\+(\d+)(?:,(\d+))?/);
        if (!m) continue;
        const start = Number(m[1]);
        const count = Number(m[2] || "1");
        const end = start + Math.max(count, 1) - 1;
        ranges.push([start, end]);
      }
    }

    // If we somehow didn't parse any hunks, fallback to file-level
    if (ranges.length === 0) ranges.push([1, Number.MAX_SAFE_INTEGER]);
  }

  return out;
}

module.exports = { prDiffToChangedRanges };
