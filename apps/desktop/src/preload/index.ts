import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("repttyl", {
  version: "0.1.0",
});

