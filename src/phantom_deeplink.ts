import { InlineKeyboard } from "grammy";
import type { LstSymbol } from "./lsts.ts";

// dialect.to renders any Solana Action URL as a Blink (one-tap mobile signing).
// Phantom mobile, Solflare, Backpack, and Jupiter Mobile all render Blinks.
// (dial.to subdomain was paused on Vercel; the apex dialect.to is the live host.)
const BLINK_RENDERER = "https://dialect.to/";

// User-supplied 90s timeout for pending rotations. This matches the TTL_MS in
// actions/server.ts so the deeplink and the pendingRotations row expire together.
export const ROTATION_TIMEOUT_MS = 90 * 1000;

export interface RotationDeeplink {
  actionUrl: string;
  blinkUrl: string;
  expiresAt: Date;
}

export function buildRotationDeeplink(args: {
  host: string;
  rotationId: string;
}): RotationDeeplink {
  const host = args.host.replace(/\/$/, "");
  const actionUrl = `solana-action:${host}/api/actions/rotate/${args.rotationId}`;
  const blinkUrl = `${BLINK_RENDERER}?action=${encodeURIComponent(actionUrl)}`;
  return {
    actionUrl,
    blinkUrl,
    expiresAt: new Date(Date.now() + ROTATION_TIMEOUT_MS),
  };
}

export function buildRotationKeyboard(args: {
  blinkUrl: string;
  source: LstSymbol;
  dest: LstSymbol;
}): InlineKeyboard {
  return new InlineKeyboard().url(
    `Sign with mobile wallet: ${args.source} → ${args.dest}`,
    args.blinkUrl,
  );
}

// Pending-rotation callback registry. The actions server already enforces a 90s
// TTL on the DB row; this in-memory map adds per-chat callbacks so the bot can
// notify the user when their rotation lands (or times out). Keyed by rotation id.
type PendingCallback = {
  chatId: number;
  source: LstSymbol;
  dest: LstSymbol;
  timer: NodeJS.Timeout;
};

const pendingCallbacks = new Map<string, PendingCallback>();

export function trackPendingRotation(args: {
  rotationId: string;
  chatId: number;
  source: LstSymbol;
  dest: LstSymbol;
  onTimeout: () => void | Promise<void>;
}): void {
  const existing = pendingCallbacks.get(args.rotationId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pendingCallbacks.delete(args.rotationId);
    Promise.resolve(args.onTimeout()).catch((err) => {
      console.error(`pending rotation ${args.rotationId} timeout cb:`, err);
    });
  }, ROTATION_TIMEOUT_MS);

  pendingCallbacks.set(args.rotationId, {
    chatId: args.chatId,
    source: args.source,
    dest: args.dest,
    timer,
  });
}

export function resolvePendingRotation(rotationId: string): {
  chatId: number;
  source: LstSymbol;
  dest: LstSymbol;
} | null {
  const entry = pendingCallbacks.get(rotationId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(rotationId);
  return { chatId: entry.chatId, source: entry.source, dest: entry.dest };
}

export function cancelPendingRotation(rotationId: string): void {
  const entry = pendingCallbacks.get(rotationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(rotationId);
}
