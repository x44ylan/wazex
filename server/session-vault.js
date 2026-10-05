import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

export class SessionVault {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "waze-session.enc");
    this.keyFile = join(directory, "session.key");
    const supplied = process.env.WAZEX_SESSION_KEY;
    if (supplied) this.key = Buffer.from(supplied, "base64");
    else if (existsSync(this.keyFile)) this.key = readFileSync(this.keyFile);
    else {
      if (existsSync(this.file))
        throw new Error(
          "The saved session key is missing. Restore session.key or remove waze-session.enc and reconnect. Drive storage is unaffected.",
        );
      this.key = randomBytes(32);
      writeFileSync(this.keyFile, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32)
      throw new Error(
        "WAZEX_SESSION_KEY must be a base64-encoded 32-byte key.",
      );
  }
  load() {
    if (!existsSync(this.file)) return null;
    try {
      const { iv, tag, data } = JSON.parse(readFileSync(this.file, "utf8"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64"),
      );
      decipher.setAAD(Buffer.from("wazex-session-v1"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new Error(
        "The saved Waze session could not be decrypted. Restore or remove waze-session.enc and reconnect. Drive storage is unaffected.",
      );
    }
  }
  save(jar) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("wazex-session-v1"));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(jar), "utf8"),
      cipher.final(),
    ]);
    const temp = `${this.file}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
      { mode: 0o600 },
    );
    renameSync(temp, this.file);
  }
  clear() {
    rmSync(this.file, { force: true });
  }
}
