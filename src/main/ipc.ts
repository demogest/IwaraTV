import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { INVOKE_CHANNELS, type InvokeChannel, type IpcResponse } from "../shared/ipc";
import type { Handlers, Validators } from "./ipc-handlers";
import { serializeError } from "./lib/app-error";

/**
 * Registers one `ipcMain.handle` per contract channel. Every response is an
 * envelope so error codes survive the trip to the renderer.
 */
export function registerIpc(handlers: Handlers, validators: Validators, isTrustedSender: (event: IpcMainInvokeEvent) => boolean): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResponse<unknown>> => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "Untrusted IPC sender." } };
      }
      try {
        const parsed = validators[channel](args) as never[];
        const handler = handlers[channel as InvokeChannel] as (...values: never[]) => unknown;
        return { ok: true, data: await handler(...parsed) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    });
  }
}
