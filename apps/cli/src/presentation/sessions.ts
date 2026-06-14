import type { Session } from "@repttyl/protocol-client";
import type { Writable } from "node:stream";

export function renderSessions(sessions: Session[], output: Writable): void {
  if (sessions.length === 0) {
    output.write("No sessions found.\n");
    return;
  }

  output.write("Sessions\n");
  for (const session of sessions) {
    output.write(`  ${session.name}  ${session.status}\n`);
  }
}
