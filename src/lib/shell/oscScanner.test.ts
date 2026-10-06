import { expect, it } from "vitest";
import { OscScanner, promotableClaude } from "./oscScanner";
const encode = (text: string) => new TextEncoder().encode(text);
const stream =
  "\x1b]7;file://localhost/tmp/a%20b\x07\x1b]133;A\x07prompt\x1b]133;B\x07\x1b]633;E;ZWNobyBoaQ==\x07\x1b]133;C\x07hello\r\n\x1b]133;D;0\x07";
it("rebuilds identical command blocks across every byte boundary including replay", () => {
  const expected = new OscScanner().push(encode(stream));
  for (let split = 1; split < stream.length; split++) {
    const scanner = new OscScanner();
    scanner.push(encode(stream.slice(0, split)));
    expect(scanner.push(encode(stream.slice(split)))).toEqual(expected);
  }
  expect(expected.completed[0]).toMatchObject({
    command: "echo hi",
    output: "hello\r\n",
    exitCode: 0,
    cwd: "/tmp/a b",
  });
});
it("keeps interactive and alternative-screen programs live until the shell returns", () => {
  const scanner = new OscScanner();
  scanner.push(encode("\x1b]133;C\x07\x1b[?1049hvim"));
  expect(scanner.state.alternateScreen).toBe(true);
  expect(scanner.state.promptReady).toBe(false);
  scanner.push(
    encode("\x1b[?1049l\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07"),
  );
  expect(scanner.state.alternateScreen).toBe(false);
  expect(scanner.state.promptReady).toBe(true);
});
it("unknown shells and malformed integration stay continuous and bounded", () => {
  const scanner = new OscScanner();
  scanner.push(encode("plain shell\x1b]bad" + "x".repeat(100000)));
  expect(scanner.state.integrated).toBe(false);
  scanner.push(encode("\x1b]133;C\x07" + "x".repeat(400000)));
  expect(scanner.state.running?.output.length).toBe(256 * 1024);
});
it("handles unicode, ST terminators, unsafe OSC paths, and reset", () => {
  const scanner = new OscScanner();
  scanner.push(encode("\x1b]7;file://remote/secret\x1b\\\x1b]133;C\x1b\\"));
  const bytes = encode("界");
  for (const byte of bytes) scanner.push(new Uint8Array([byte]));
  scanner.push(encode("\x1b]133;D;4\x1b\\"));
  expect(scanner.state.cwd).toBeNull();
  expect(scanner.state.completed[0].output).toBe("界");
  expect(scanner.state.completed[0].exitCode).toBe(4);
  scanner.reset();
  expect(scanner.state.completed).toEqual([]);
});
it("never promotes compound shell syntax", () => {
  expect(promotableClaude("claude --resume abc")).toBe(true);
  expect(promotableClaude("claude")).toBe(true);
  for (const command of [
    "echo claude",
    "claude | tee log",
    "claude; rm file",
    "claude $(touch file)",
    "claude > out",
    'claude "$TOKEN"',
    "claude *.txt",
  ])
    expect(promotableClaude(command)).toBe(false);
});
