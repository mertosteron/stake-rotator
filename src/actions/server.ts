import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { LstSymbol } from "../lsts.ts";

export interface PendingRotation {
  id: string;
  telegramId: bigint;
  walletPubkey: string;
  source: LstSymbol;
  dest: LstSymbol;
  swapTransactionBase64: string;
  apyUpliftPp: number;
  expiresAt: number;
}

const TTL_MS = 90 * 1000;

const pending = new Map<string, PendingRotation>();

export function registerRotation(r: Omit<PendingRotation, "expiresAt">): PendingRotation {
  const full: PendingRotation = { ...r, expiresAt: Date.now() + TTL_MS };
  pending.set(r.id, full);
  return full;
}

export function getRotation(id: string): PendingRotation | undefined {
  const r = pending.get(id);
  if (!r) return undefined;
  if (Date.now() > r.expiresAt) {
    pending.delete(id);
    return undefined;
  }
  return r;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
    "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
    "X-Action-Version": "2.4",
    "X-Blockchain-Ids": "solana:101",
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...corsHeaders(), "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseRotateId(pathname: string): string | null {
  const m = pathname.match(/^\/api\/actions\/rotate\/([A-Za-z0-9_-]{1,64})\/?$/);
  return m && m[1] ? m[1] : null;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!req.url) {
    send(res, 400, { message: "no url" });
    return;
  }
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const id = parseRotateId(url.pathname);
  if (!id) {
    send(res, 404, { message: "not found" });
    return;
  }
  const r = getRotation(id);
  if (!r) {
    send(res, 404, { message: "rotation expired or not found" });
    return;
  }

  if (req.method === "GET") {
    send(res, 200, {
      type: "action",
      icon: "https://solana.com/favicon.ico",
      label: `Rotate ${r.source} → ${r.dest}`,
      title: `Stake Rotator: ${r.source} → ${r.dest}`,
      description: `Approve to rotate your stake. Estimated +${r.apyUpliftPp.toFixed(2)}pp APY.`,
    });
    return;
  }

  if (req.method === "POST") {
    let body: { account?: unknown };
    try {
      body = (await readJson(req)) as { account?: unknown };
    } catch {
      send(res, 400, { message: "invalid json" });
      return;
    }
    const account = typeof body.account === "string" ? body.account : "";
    if (account !== r.walletPubkey) {
      send(res, 400, { message: "account does not match bound wallet" });
      return;
    }
    send(res, 200, {
      transaction: r.swapTransactionBase64,
      message: `Rotate ${r.source} → ${r.dest} (+${r.apyUpliftPp.toFixed(2)}pp)`,
    });
    return;
  }

  send(res, 405, { message: "method not allowed" });
}

export function startActionsServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("actions server error:", err);
      if (!res.headersSent) send(res, 500, { message: "internal error" });
    });
  });
  server.listen(port, () => {
    console.log(`actions server listening on :${port}`);
  });
  return server;
}
