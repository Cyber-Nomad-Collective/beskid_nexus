import { jwtVerify, SignJWT } from 'jose';
import type { Request, Response } from 'express';
import type { NexusSessionPayload } from './types.js';

export const SESSION_COOKIE_NAME = 'beskid_nexus_session';

function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

export const sealSession = async (payload: NexusSessionPayload): Promise<string> => {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionSecret());
};

export const unsealSession = async (token: string): Promise<NexusSessionPayload | null> => {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (typeof payload.login !== 'string') {
      return null;
    }
    if (
      typeof payload.hubUserToken !== 'string' ||
      typeof payload.hubSessionId !== 'string'
    ) {
      return null;
    }
    return {
      login: payload.login,
      avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : '',
      name: typeof payload.name === 'string' ? payload.name : null,
      hubUserToken: payload.hubUserToken,
      hubSessionId: payload.hubSessionId,
    };
  } catch {
    return null;
  }
};

export const readSessionCookie = (req: Request): string | null => {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
};

export const getSessionFromRequest = async (req: Request): Promise<NexusSessionPayload | null> => {
  const token = readSessionCookie(req);
  if (!token) return null;
  return unsealSession(token);
};

export const sessionCookieHeader = (token: string, maxAgeSeconds = 60 * 60 * 24 * 7): string => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
};

export const clearSessionCookieHeader = (): string => {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
};

export const appendSetCookie = (res: Response, cookie: string): void => {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  const list = Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, cookie]);
};
