const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  const dir = path.extname(filePath) ? path.dirname(filePath) : filePath;
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function forEachUniversalMapTest(mapPath, onTest) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(mapPath, { encoding: "utf8" });

    let done = false;
    let seenTestsArray = false;
    let inTestsArray = false;
    let seekTestsKey = true;
    let seekArrayStart = false;
    let keyWindow = "";

    let objectDepth = 0;
    let objectText = "";
    let inString = false;
    let escaped = false;

    let count = 0;

    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
      input.destroy();
    };

    const parseObject = () => {
      let entry;
      try {
        entry = JSON.parse(objectText);
      } catch (err) {
        throw new Error(`Invalid test entry JSON in ${mapPath}: ${err.message}`);
      }
      count += 1;
      onTest(entry);
      objectText = "";
    };

    input.on("data", (chunk) => {
      try {
        for (const ch of chunk) {
          if (objectDepth > 0) {
            objectText += ch;

            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === "\\") {
              if (inString) escaped = true;
              continue;
            }
            if (ch === '"') {
              inString = !inString;
              continue;
            }
            if (!inString) {
              if (ch === "{") {
                objectDepth += 1;
              } else if (ch === "}") {
                objectDepth -= 1;
                if (objectDepth === 0) parseObject();
              }
            }
            continue;
          }

          if (!inTestsArray) {
            keyWindow = (keyWindow + ch).slice(-32);
            if (seekTestsKey && keyWindow.endsWith('"tests"')) {
              seekTestsKey = false;
              seekArrayStart = true;
              continue;
            }
            if (seekArrayStart && ch === "[") {
              seekArrayStart = false;
              inTestsArray = true;
              seenTestsArray = true;
            }
            continue;
          }

          if (/\s/.test(ch) || ch === ",") continue;
          if (ch === "]") {
            inTestsArray = false;
            continue;
          }
          if (ch === "{") {
            objectDepth = 1;
            objectText = "{";
            inString = false;
            escaped = false;
            continue;
          }
          throw new Error(`Unexpected token '${ch}' while reading ${mapPath}`);
        }
      } catch (err) {
        fail(err);
      }
    });

    input.on("error", fail);

    input.on("end", () => {
      if (done) return;
      if (!seenTestsArray) {
        return fail(new Error(`Invalid universal map: missing "tests" array in ${mapPath}`));
      }
      if (objectDepth !== 0) {
        return fail(new Error(`Invalid universal map: unterminated test entry in ${mapPath}`));
      }
      done = true;
      resolve(count);
    });
  });
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

module.exports = { ensureDir, loadJson, forEachUniversalMapTest, saveJson };
