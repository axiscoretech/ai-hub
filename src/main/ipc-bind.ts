import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { invokeChannels, type InvokeChannel } from "../shared/ipc";

const known = new Set<string>(invokeChannels);

export function handle(
  channel: InvokeChannel,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) {
  if (!known.has(channel)) {
    throw new Error(`Unknown IPC channel ${channel}`);
  }
  ipcMain.handle(channel, listener);
}
