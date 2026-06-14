import { Terminal } from "@xterm/xterm";
import type { Workspace } from "@repttyl/protocol-client";
import "@xterm/xterm/css/xterm.css";

const app = document.getElementById("app");
type WorkspacePreview = Pick<Workspace, "name" | "status">;

if (app) {
  const terminal = new Terminal({ cursorBlink: true });
  terminal.open(app);
  terminal.writeln("Repttyl desktop scaffold");
}

export type { WorkspacePreview };
