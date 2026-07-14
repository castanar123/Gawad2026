import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { remoteCameraSessions } from "@/db/schema";

export const runtime = "edge";

type RouteContext = { params: Promise<{ id: string }> };

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readToken(request: Request) {
  const url = new URL(request.url);
  return request.headers.get("x-camera-token") || url.searchParams.get("token") || "";
}

async function authorizedSession(request: Request, id: string) {
  const token = readToken(request);
  if (!token) return null;
  const db = await getDb();
  const [session] = await db.select().from(remoteCameraSessions).where(and(
    eq(remoteCameraSessions.id, id.toUpperCase()),
    eq(remoteCameraSessions.tokenHash, await hashToken(token)),
    gt(remoteCameraSessions.expiresAt, Date.now()),
  )).limit(1);
  return session ?? null;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await authorizedSession(request, id);
    if (!session) return Response.json({ error: "Pairing session not found or expired." }, { status: 404 });
    return Response.json({
      id: session.id,
      offer: session.offer ? JSON.parse(session.offer) : null,
      answer: session.answer ? JSON.parse(session.answer) : null,
      status: session.status,
      expiresAt: session.expiresAt,
    });
  } catch {
    return Response.json({ error: "The pairing session could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await authorizedSession(request, id);
    if (!session) return Response.json({ error: "Pairing session not found or expired." }, { status: 404 });

    const payload = await request.json() as {
      role?: "booth" | "phone";
      offer?: RTCSessionDescriptionInit;
      answer?: RTCSessionDescriptionInit;
      status?: "waiting" | "phone-ready" | "connected" | "closed";
    };
    if (payload.role !== "booth" && payload.role !== "phone") {
      return Response.json({ error: "A valid pairing role is required." }, { status: 400 });
    }

    const updates: Partial<typeof remoteCameraSessions.$inferInsert> = { updatedAt: Date.now() };
    if (payload.role === "booth" && payload.offer) updates.offer = JSON.stringify(payload.offer);
    if (payload.role === "phone" && payload.answer) updates.answer = JSON.stringify(payload.answer);
    if (payload.status) updates.status = payload.status;

    const db = await getDb();
    await db.update(remoteCameraSessions).set(updates).where(eq(remoteCameraSessions.id, session.id));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "The pairing session could not be updated." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await authorizedSession(request, id);
    if (!session) return Response.json({ ok: true });
    const db = await getDb();
    await db.delete(remoteCameraSessions).where(eq(remoteCameraSessions.id, session.id));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: true });
  }
}
