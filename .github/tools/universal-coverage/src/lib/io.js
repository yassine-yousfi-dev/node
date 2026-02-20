const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  const dir = path.extname(filePath) ? path.dirname(filePath) : filePath;
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

module.exports = { ensureDir, loadJson, saveJson };
