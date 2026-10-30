import { timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { config, sha256 } from "./config.ts";
import { db, hashPassword, type Role, type Task, type User } from "./db.ts";

export type SessionUser = Pick<User, "_id" | "email" | "name" | "role">;
const COOKIE = "tl_session";

export async function checkPassword(email: string, password: string): Promise<User | null> {
  const user = await db.users.findOne({ email: email.toLowerCase().trim() });
  if (!user) return null;
  const { passwordHash } = hashPassword(password, user.salt);
  const a = Buffer.from(passwordHash, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? user : null;
}

export function setSession(res: Response, user: User) {
  const token = jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: user._id,
    audience: "user",
    algorithm: "HS256",
    expiresIn: config.sessionTtlSeconds,
  });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.publicUrl.startsWith("https"), maxAge: config.sessionTtlSeconds * 1000 });
}

export const clearSession = (res: Response) => res.clearCookie(COOKIE);

export const requireUser: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[COOKIE];
  try {
    const payload = jwt.verify(token ?? "", config.jwtSecret, { audience: "user", algorithms: ["HS256"] }) as jwt.JwtPayload;
    const user = await db.users.findOne({ _id: String(payload.sub) }, { projection: { passwordHash: 0, salt: 0 } });
    if (!user) throw new Error("gone");
    res.locals.user = user as SessionUser;
    next();
  } catch {
    res.status(401).json({ error: "not signed in" });
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (_req, res, next) => {
    if (roles.includes((res.locals.user as SessionUser).role)) return next();
    res.status(403).json({ error: "not allowed" });
  };

// Who may see a task: its client, its developer, or an admin.
export const canSeeTask = (u: SessionUser, t: Pick<Task, "clientId" | "developerId">) =>
  u.role === "admin" || t.clientId === u._id || t.developerId === u._id;

export const taskFilter = (u: SessionUser) =>
  u.role === "admin" ? {} : u.role === "client" ? { clientId: u._id } : { developerId: u._id };

// ---- runners: long-lived runner token -> 15-minute JWT for the WebSocket handshake ----
export async function issueRunnerJwt(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const runner = await db.runners.findOne({ tokenHash: sha256(token), revokedAt: { $exists: false } });
  if (!runner) return null;
  const signed = jwt.sign({ owner: runner.ownerId }, config.jwtSecret, {
    subject: runner._id,
    audience: "runner",
    algorithm: "HS256",
    expiresIn: config.runnerJwtTtlSeconds,
  });
  return { jwt: signed, expiresIn: config.runnerJwtTtlSeconds };
}

export function verifyRunnerJwt(authorization: string | undefined): string | null {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { audience: "runner", algorithms: ["HS256"] }) as jwt.JwtPayload;
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
