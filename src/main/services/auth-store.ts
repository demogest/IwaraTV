import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { AuthState } from "../../shared/types";

interface PersistedAuth {
  email: string;
  userToken: string;
}

export class AuthStore {
  private readonly filePath: string;
  private persisted?: PersistedAuth;
  private mediaToken?: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "auth.bin");
    this.persisted = this.load();
  }

  getUserToken(): string | undefined {
    return this.persisted?.userToken;
  }

  getMediaToken(): string | undefined {
    return this.mediaToken;
  }

  setMediaToken(token: string): void {
    this.mediaToken = token;
  }

  saveUserToken(email: string, userToken: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      this.persisted = { email, userToken };
      return;
    }

    this.persisted = { email, userToken };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.persisted));
    writeFileSync(this.filePath, encrypted);
  }

  clear(): void {
    this.persisted = undefined;
    this.mediaToken = undefined;
    if (existsSync(this.filePath)) {
      rmSync(this.filePath);
    }
  }

  state(): AuthState {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    return {
      loggedIn: Boolean(this.persisted?.userToken),
      email: this.persisted?.email,
      hasMediaToken: Boolean(this.mediaToken),
      encryptionAvailable,
      warning: encryptionAvailable ? undefined : "系统安全存储不可用，本次登录不会持久化到磁盘。"
    };
  }

  private load(): PersistedAuth | undefined {
    try {
      if (!safeStorage.isEncryptionAvailable() || !existsSync(this.filePath)) {
        return undefined;
      }

      const encrypted = readFileSync(this.filePath);
      return JSON.parse(safeStorage.decryptString(encrypted)) as PersistedAuth;
    } catch {
      return undefined;
    }
  }
}

