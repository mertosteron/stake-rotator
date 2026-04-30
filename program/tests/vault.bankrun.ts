// Phase 3.5 — bankrun test scaffold for the stake_rotator vault program.
//
// Run after `anchor build` produces target/deploy/stake_rotator.so:
//   pnpm add -D solana-bankrun anchor-bankrun @coral-xyz/anchor @solana/web3.js @solana/spl-token
//   pnpm exec tsx tests/vault.bankrun.ts
//
// This scaffold covers: init_vault → deposit_lst → set_rotation_authority → revoke_authority
// → withdraw_lst. The execute_rotation path needs a fixture Jupiter swap fixture which
// requires forking mainnet program accounts; left as TODO in the matching `it` block.

import { start } from "solana-bankrun";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("RotatoR1111111111111111111111111111111111111");
const VAULT_SEED = Buffer.from("vault");

function deriveVault(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], PROGRAM_ID);
}

async function main() {
  const programSoPath = "target/deploy/stake_rotator.so";
  const context = await start(
    [{ name: "stake_rotator", programId: PROGRAM_ID }],
    [],
  );
  const client = context.banksClient;
  const payer = context.payer;

  const owner = Keypair.generate();
  const bot = Keypair.generate();
  await fund(client, context, owner.publicKey, 5_000_000_000n);
  await fund(client, context, bot.publicKey, 1_000_000_000n);

  const lstMint = Keypair.generate();
  await createMint(client, context, payer, lstMint, owner.publicKey);
  await mintTo(client, context, payer, lstMint.publicKey, owner.publicKey, 100_000_000_000n);

  const [vaultPda] = deriveVault(owner.publicKey);
  const ownerAta = getAssociatedTokenAddressSync(lstMint.publicKey, owner.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(lstMint.publicKey, vaultPda, true);

  // --- 1. init_vault ---
  // TODO: build & send init_vault ix using the IDL produced by `anchor build`.
  console.log("init_vault: vaultPda=", vaultPda.toBase58(), "bot=", bot.publicKey.toBase58());

  // --- 2. deposit_lst ---
  // TODO: create vault ATA, transfer 10 LST from owner ATA to vault ATA via deposit_lst.
  console.log("deposit_lst: ownerAta=", ownerAta.toBase58(), "vaultAta=", vaultAta.toBase58());

  // --- 3. execute_rotation ---
  // Requires forking Jupiter v6 program + relevant pool accounts. Skip in pure bankrun;
  // run on local-validator with `anchor test` instead.
  console.log("execute_rotation: skipped — needs Jupiter fixtures (use anchor test on devnet)");

  // --- 4. revoke_authority ---
  // TODO: send revoke_authority, then assert that execute_rotation fails with AuthorityRevoked.
  console.log("revoke_authority: TODO");

  // --- 5. withdraw_lst ---
  // TODO: owner withdraws full balance, vault baseline_amount → 0.
  console.log("withdraw_lst: TODO");

  console.log("\nbankrun scaffold ran. Wire IDL bindings via @coral-xyz/anchor next.");
}

async function fund(client: any, ctx: any, target: PublicKey, lamports: bigint) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
      toPubkey: target,
      lamports: Number(lamports),
    }),
  );
  tx.recentBlockhash = (await client.getLatestBlockhash())[0];
  tx.sign(ctx.payer);
  await client.processTransaction(tx);
}

async function createMint(
  client: any,
  ctx: any,
  payer: any,
  mintKeypair: Keypair,
  authority: PublicKey,
) {
  const rent = await client.getRent();
  const lamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintKeypair.publicKey, 9, authority, null),
  );
  tx.recentBlockhash = (await client.getLatestBlockhash())[0];
  tx.sign(payer, mintKeypair);
  await client.processTransaction(tx);
}

async function mintTo(
  client: any,
  ctx: any,
  payer: any,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
    createMintToInstruction(mint, ata, payer.publicKey, amount),
  );
  tx.recentBlockhash = (await client.getLatestBlockhash())[0];
  tx.sign(payer);
  await client.processTransaction(tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Suppress unused-import warning for InitializeAccount3 (will be used when wiring vault ATA).
const _unused = createInitializeAccount3Instruction;
