import assert from "node:assert/strict";
import test from "node:test";

import { encodeLspMessage } from "../src/adapters/code/lsp.js";
import { runProcess } from "../src/process.js";

test("process runner captures output and timeout semantics", async () => {
  const ok = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    timeoutMs: 5_000,
  });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, "ok");

  const timeout = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 10000)"],
    timeoutMs: 20,
  });
  assert.equal(timeout.timedOut, true);
});

test("LSP framing uses byte-accurate Content-Length", () => {
  const frame = encodeLspMessage({ jsonrpc: "2.0", method: "x", params: { text: "你好" } });
  const [header, body] = frame.toString("utf8").split("\r\n\r\n");
  assert.match(header ?? "", /Content-Length: \d+/);
  assert.equal(Number(/\d+/.exec(header ?? "")?.[0]), Buffer.byteLength(body ?? "", "utf8"));
});
