import type { Workspace } from "@repttyl/protocol-client";
import type { Writable } from "node:stream";

export function renderWorkspaces(workspaces: Workspace[], output: Writable): void {
  if (workspaces.length === 0) {
    output.write("No workspaces found.\n");
    return;
  }

  const rows = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    status: workspace.status ?? "unknown",
    path: workspace.path,
  }));

  const widths = {
    id: maxWidth("ID", rows.map((row) => row.id)),
    name: maxWidth("Name", rows.map((row) => row.name)),
    status: maxWidth("Status", rows.map((row) => row.status)),
    path: maxWidth("Path", rows.map((row) => row.path)),
  };

  output.write(
    `${pad("ID", widths.id)}  ${pad("Name", widths.name)}  ${pad("Status", widths.status)}  ${pad("Path", widths.path)}\n`,
  );
  output.write(
    `${"-".repeat(widths.id)}  ${"-".repeat(widths.name)}  ${"-".repeat(widths.status)}  ${"-".repeat(widths.path)}\n`,
  );

  for (const row of rows) {
    output.write(
      `${pad(row.id, widths.id)}  ${pad(row.name, widths.name)}  ${pad(row.status, widths.status)}  ${pad(row.path, widths.path)}\n`,
    );
  }
}

function maxWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
