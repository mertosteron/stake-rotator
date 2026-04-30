// Phase 4.1 — minimal client for the stake_rotator Anchor program.
// Hand-rolls instruction encoding using the standard Anchor discriminator
// (first 8 bytes of sha256("global:<method>")). Replace with a generated IDL
// client after `anchor build` produces target/idl/stake_rotator.json.

import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "./const.ts";

export const STAKE_ROTATOR_PROGRAM_ID = new PublicKey(
  "RotatoR1111111111111111111111111111111111111",
);
export const JUPITER_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

const VAULT_SEED = Buffer.from("vault");

function disc(method: string): Buffer {
  return createHash("sha256").update(`global:${method}`).digest().subarray(0, 8);
}

function encU64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function encU16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function encVecU8(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([len, Buffer.from(data)]);
}

export function deriveVault(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], STAKE_ROTATOR_PROGRAM_ID);
}

export function ixInitVault(
  owner: PublicKey,
  rotationAuthority: PublicKey,
  perfFeeBpsMax: number,
): TransactionInstruction {
  const [vault] = deriveVault(owner);
  const data = Buffer.concat([
    disc("init_vault"),
    rotationAuthority.toBuffer(),
    encU16(perfFeeBpsMax),
  ]);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function ixDepositLst(
  owner: PublicKey,
  lstMint: PublicKey,
  ownerAta: PublicKey,
  vaultAta: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const [vault] = deriveVault(owner);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: lstMint, isSigner: false, isWritable: false },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("deposit_lst"), encU64(amount)]),
  });
}

export function ixWithdrawLst(
  owner: PublicKey,
  lstMint: PublicKey,
  ownerAta: PublicKey,
  vaultAta: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const [vault] = deriveVault(owner);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: lstMint, isSigner: false, isWritable: false },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("withdraw_lst"), encU64(amount)]),
  });
}

export function ixRevokeAuthority(owner: PublicKey): TransactionInstruction {
  const [vault] = deriveVault(owner);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: disc("revoke_authority"),
  });
}

export function ixSetRotationAuthority(
  owner: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction {
  const [vault] = deriveVault(owner);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc("set_rotation_authority"), newAuthority.toBuffer()]),
  });
}

/**
 * Build execute_rotation. `jupiterAccounts` is the full ordered account list that
 * Jupiter's /swap-instructions endpoint returned for this swap. They are forwarded
 * via remaining_accounts.
 */
export function ixExecuteRotation(
  vaultOwner: PublicKey,
  rotationAuthority: PublicKey,
  sourceMint: PublicKey,
  destMint: PublicKey,
  vaultSourceAta: PublicKey,
  vaultDestAta: PublicKey,
  swapData: Uint8Array,
  minOutAmount: bigint,
  jupiterAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
): TransactionInstruction {
  const [vault] = deriveVault(vaultOwner);
  const data = Buffer.concat([
    disc("execute_rotation"),
    encVecU8(swapData),
    encU64(minOutAmount),
  ]);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: rotationAuthority, isSigner: true, isWritable: false },
      { pubkey: sourceMint, isSigner: false, isWritable: false },
      { pubkey: destMint, isSigner: false, isWritable: false },
      { pubkey: vaultSourceAta, isSigner: false, isWritable: true },
      { pubkey: vaultDestAta, isSigner: false, isWritable: true },
      { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...jupiterAccounts,
    ],
    data,
  });
}

export function ixClaimPerfFee(
  vaultOwner: PublicKey,
  rotationAuthority: PublicKey,
  currentLstMint: PublicKey,
  vaultAta: PublicKey,
  feeDestination: PublicKey,
  currentSolValuePerLst: bigint,
  feeBps: number,
): TransactionInstruction {
  const [vault] = deriveVault(vaultOwner);
  return new TransactionInstruction({
    programId: STAKE_ROTATOR_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: rotationAuthority, isSigner: true, isWritable: false },
      { pubkey: currentLstMint, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: feeDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("claim_performance_fee"),
      encU64(currentSolValuePerLst),
      encU16(feeBps),
    ]),
  });
}
