import crypto from "crypto";

// Stable encryption key: uses env var in production, fixed key in dev to survive restarts
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const IV_LENGTH = 16;

if (!process.env.ENCRYPTION_KEY) {
  console.warn("[ENCRYPTION] Using default dev key. Set ENCRYPTION_KEY env var in production!");
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 2) return encryptedText;

  const iv = Buffer.from(parts[0], "hex");
  const encrypted = Buffer.from(parts[1], "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

export function encryptApiKey(key: string): string {
  if (!key || key.startsWith("enc:")) return key;
  return "enc:" + encrypt(key);
}

export function decryptApiKey(key: string): string {
  if (!key || !key.startsWith("enc:")) return key;
  return decrypt(key.substring(4));
}

export function encryptFields(obj: Record<string, any>, fields: string[]): Record<string, any> {
  const result = { ...obj };
  for (const field of fields) {
    if (result[field] && typeof result[field] === "string") {
      result[field] = encryptApiKey(result[field]);
    }
  }
  return result;
}

export function decryptFields(obj: Record<string, any>, fields: string[]): Record<string, any> {
  const result = { ...obj };
  for (const field of fields) {
    if (result[field] && typeof result[field] === "string") {
      result[field] = decryptApiKey(result[field]);
    }
  }
  return result;
}
