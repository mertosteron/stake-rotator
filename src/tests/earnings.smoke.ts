// Smoke test scenarios for the new modules. Run with:
//   pnpm tsx src/tests/earnings.smoke.ts
//
// Network-touching pieces (Jupiter price, Sanctum) are exercised. DB-touching
// pieces are not — those need DATABASE_URL and migrated tables; covered by the
// dry-run instructions printed at the end of the file.

import { buildRotationDeeplink, buildRotationKeyboard } from "../phantom_deeplink.ts";
import { fetchPriceSnapshot } from "../prices.ts";
import { fetchSnapshot } from "../sanctum.ts";
import { TRACKED_LSTS, type LstSymbol } from "../lsts.ts";
import { formatEarningsReport, type EarningsReport } from "../earnings_tracker.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function testDeeplink() {
  console.log("[1] phantom_deeplink — URL builder");
  const d = buildRotationDeeplink({
    host: "https://rotator.example.com",
    rotationId: "abc-123",
  });
  assert(
    d.actionUrl ===
      "solana-action:https://rotator.example.com/api/actions/rotate/abc-123",
    `action url: ${d.actionUrl}`,
  );
  assert(d.blinkUrl.startsWith("https://dial.to/?action="), `blink: ${d.blinkUrl}`);
  assert(d.expiresAt.getTime() > Date.now() + 80_000, "expires ~90s");
  const kb = buildRotationKeyboard({
    blinkUrl: d.blinkUrl,
    source: "mSOL",
    dest: "jitoSOL",
  });
  assert(kb.inline_keyboard.length === 1, "one button row");
  assert(kb.inline_keyboard[0]!.length === 1, "one button");
  console.log("    ✓ blink URL formed, keyboard built");
}

async function testPrices() {
  console.log("[2] prices — Jupiter Price API");
  const sanctum = await fetchSnapshot(TRACKED_LSTS);
  const solPerLstMap = new Map<LstSymbol, number | null>();
  for (const s of sanctum) solPerLstMap.set(s.symbol, s.solPerLst);
  const prices = await fetchPriceSnapshot(TRACKED_LSTS, solPerLstMap);
  assert(prices.usdPerSol > 0, `SOL/USD: ${prices.usdPerSol}`);
  console.log(`    ✓ SOL/USD = $${prices.usdPerSol.toFixed(2)}`);
  for (const sym of TRACKED_LSTS) {
    const p = prices.usdPerLst.get(sym);
    if (p == null) {
      console.log(`    ⚠ ${sym}: no price (Jupiter + Sanctum both missing)`);
    } else {
      console.log(`    ✓ ${sym} = $${p.toFixed(2)}`);
    }
  }
}

function testEarningsFormat() {
  console.log("[3] earnings_tracker — report formatter");

  const empty: EarningsReport = {
    hasHistory: false,
    walletPubkey: "test",
    currentLst: "mSOL",
    daysHeld: 0,
    initialUsd: 0,
    currentUsd: 1320.5,
    pnlUsd: 0,
    pnlPct: 0,
    effectiveApy: null,
    alternatives: [],
    rotationHistory: { count: 0, estimatedContributionUsd: 0 },
  };
  const emptyOut = formatEarningsReport(empty);
  assert(emptyOut.includes("Tracking started"), "first-run stub");
  console.log("    ✓ first-run stub renders");

  const full: EarningsReport = {
    hasHistory: true,
    walletPubkey: "test",
    currentLst: "mSOL",
    daysHeld: 47,
    initialUsd: 1240,
    currentUsd: 1318.75,
    pnlUsd: 78.75,
    pnlPct: 6.35,
    effectiveApy: 0.493,
    alternatives: [
      {
        symbol: "jitoSOL",
        currentApy: 0.521,
        averageApy: 0.521,
        hypotheticalUsd: 1323.2,
        deltaUsd: 4.45,
        isCurrent: false,
        isBest: true,
      },
      {
        symbol: "mSOL",
        currentApy: 0.493,
        averageApy: 0.493,
        hypotheticalUsd: 1318.75,
        deltaUsd: 0,
        isCurrent: true,
        isBest: false,
      },
    ],
    rotationHistory: { count: 2, estimatedContributionUsd: 1.42 },
  };
  const out = formatEarningsReport(full);
  assert(out.includes("🏆"), "best LST marker");
  assert(out.includes("📍"), "current LST marker");
  assert(out.includes("+$78.75"), "PnL rendered");
  assert(out.includes("~49.30%"), "effective APY rendered");
  console.log("    ✓ full report renders\n");
  console.log("    --- sample ---");
  console.log(out);
  console.log("    --- end ---\n");
}

async function main() {
  await testDeeplink();
  await testPrices();
  testEarningsFormat();

  console.log("DB-integration manual smoke (requires DATABASE_URL + migrations):");
  console.log("  pnpm db:push                       # apply 0001_earnings_and_apy.sql");
  console.log("  pnpm bot                           # start bot");
  console.log("  /bind_wallet <pubkey>              # link wallet in Telegram");
  console.log("  /earnings                          # first call captures snapshot");
  console.log("  /earnings                          # 24h+ later, shows report");
  console.log("  /rotate                            # offers 'Sign with mobile wallet' button");
  console.log("  pnpm worker                        # captures APY samples on every tick");
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
