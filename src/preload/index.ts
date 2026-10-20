import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { isEventChannel, isInvokeChannel, type IwaraTVBridge } from "../shared/ipc";

// The renderer gets a narrow, allowlisted bridge: it can only invoke the
// channels in the IPC contract and subscribe to the declared push events.
const bridge: IwaraTVBridge = {
  invoke(channel, ...args) {
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", message: `Unknown channel: ${String(channel)}` } });
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!isEventChannel(channel)) {
      throw new Error(`Unknown event channel: ${String(channel)}`);
    }
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld("iwaraTV", bridge);
