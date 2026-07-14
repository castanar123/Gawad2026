import { lt } from "drizzle-orm";
import { getDb } from "@/db";
import { remoteCameraSessions } from "@/db/schema";

export const runtime = "edge";

const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomText(length: number, alphabet: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST() {
  try {
    const db = await getDb();
    const now = Date.now();
    await db.delete(remoteCameraSessions).where(lt(remoteCameraSessions.expiresAt, now));

    const id = randomText(8, ROOM_ALPHABET);
    const token = randomToken();
    await db.insert(remoteCameraSessions).values({
      id,
      tokenHash: await hashToken(token),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });

    return Response.json({ id, token, expiresAt: now + SESSION_LIFETIME_MS }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The pairing session could not be created.";
    const localRuntime = message.includes("cloudflare:workers") || message.includes("D1 binding");
    return Response.json({ error: localRuntime ? "Phone pairing is available on the deployed online booth. Open the live site to create a QR link." : "The secure phone pairing service is temporarily unavailable." }, { status: 500 });
  }
}
