import assert from "node:assert/strict";
import test from "node:test";

import { parseCoberturaXml } from "../src/adapters/coverage/cobertura.js";
import { parseCoverageJson } from "../src/adapters/coverage/coverage-json.js";
import { parseGoCoverProfile } from "../src/adapters/coverage/go-cover.js";
import { parseLcov } from "../src/adapters/coverage/lcov.js";
import { mergeCoverageMaps, summarizeCoverage } from "../src/coverage.js";

test("preserves native coverage capabilities", () => {
  const go = parseGoCoverProfile("mode: set\nexample.go:1.1,2.2 1 0\n", "rev");
  assert.equal(go.capabilities.block, true);
  assert.equal(go.capabilities.branch, false);
  const python = parseCoverageJson(
    JSON.stringify({ files: { "sample.py": { executed_lines: [1], missing_lines: [2], executed_branches: [[1, 2]], missing_branches: [] } } }),
    "rev",
  );
  assert.equal(python.capabilities.branch, true);
  const merged = mergeCoverageMaps([go, python]);
  assert.equal(summarizeCoverage(merged).regions, 4);
});

test("parses line, branch, function and XML formats", () => {
  const lcov = parseLcov("SF:a.ts\nFN:1,f\nFNDA:1,f\nDA:1,1\nBRDA:1,0,0,0\nend_of_record\n", "rev");
  assert.deepEqual(lcov.capabilities, {
    line: true,
    block: false,
    branch: true,
    condition: false,
    function: true,
    perTest: false,
  });
  const xml = parseCoberturaXml('<coverage><class filename="a.py"><lines><line number="1" hits="1"/></lines></class></coverage>', "rev");
  assert.equal(xml.files[0]?.regions[0]?.hits, 1);
});
