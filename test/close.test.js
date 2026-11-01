import { test } from "node:test";
import assert from "node:assert/strict";
import { closeTerminal, parseChain, shellToClose } from "../src/close.js";

const p = (pid, name, command = `"C:\\WINDOWS\\system32\\${name}"`) => ({
  pid,
  name,
  command,
});
const node = p(1, "node.exe", "node osiris\\src\\cli.js");

test("the shell typed into is closed when a terminal started it", () => {
  // cmd from the Start menu, running npm's osiris.cmd in itself.
  assert.equal(shellToClose([node, p(2, "cmd.exe"), p(3, "explorer.exe")]), 2);
  // PowerShell in a Windows Terminal tab, through the .cmd shim (cmd /c).
  assert.equal(
    shellToClose([
      node,
      p(2, "cmd.exe", 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "osiris.cmd"'),
      p(3, "powershell.exe"),
      p(4, "WindowsTerminal.exe"),
    ]),
    3,
  );
  // A window a restore opened (cmd /k), whose starter is gone.
  assert.equal(
    shellToClose([node, p(2, "cmd.exe", "cmd.exe /d /k C:\\x\\launch.cmd")]),
    2,
  );
});

test("a shell inside another program stays", () => {
  // An editor's terminal.
  assert.equal(shellToClose([node, p(2, "pwsh.exe"), p(3, "Code.exe")]), null);
  // Claude Code running a command.
  assert.equal(
    shellToClose([
      node,
      p(2, "bash.exe", "bash -c 'osiris restore --yes'"),
      p(3, "claude.exe"),
    ]),
    null,
  );
  // A shell in a shell.
  assert.equal(
    shellToClose([node, p(2, "cmd.exe"), p(3, "powershell.exe")]),
    null,
  );
  // Started by something that is not a shell.
  assert.equal(shellToClose([node, p(2, "svchost.exe")]), null);
  assert.equal(shellToClose([node]), null);
});

test("the chain is read from PowerShell, and the shell ended with code 0", () => {
  assert.deepEqual(
    parseChain('10|20|node.exe|node a|b.js\r\n20|30|cmd.exe|"cmd.exe"\r\n'),
    [
      { pid: 10, ppid: 20, name: "node.exe", command: "node a|b.js" },
      { pid: 20, ppid: 30, name: "cmd.exe", command: '"cmd.exe"' },
    ],
  );
  const calls = [];
  const run = (file, args) => {
    calls.push(args.at(-1));
    return calls.length === 1
      ? {
          status: 0,
          stdout:
            "10|20|node.exe|node\n20|30|cmd.exe|cmd.exe\n30|1|explorer.exe|x\n",
        }
      : { status: 0, stdout: "" };
  };
  assert.equal(closeTerminal({ pid: 10, platform: "win32", run }), 20);
  assert.match(calls[1], /ProcessId=20'.*Terminate.*Reason = \[uint32\]0/);
  assert.equal(closeTerminal({ pid: 10, platform: "linux", run }), null);
});
