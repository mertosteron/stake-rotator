// Executable smoke tests for the stake_rotator client-side instruction builder.
//
// This intentionally stays lightweight: the pure Anchor program state tests should
// live next to the generated IDL after `anchor build`, while this file protects the
// PDA derivation, account ordering, discriminators and binary argument layout that
// the bot/worker rely on before they submit transactions.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  deriveVault,
  ixClaimPerfFee,
  ixDepositLst,
  ixExecuteRotation,
  ixInitVault,
  ixRevokeAuthority,
  ixSetRotationAuthority,
  ixWithdrawLst,
  JUPITER_V6_PROGRAM_ID,
  STAKE_ROTATOR_PROGRAM_ID,
} from "../../src/program.ts";

function disc(method: string): Buffer {
  return createHash("sha256")
    .update(`global:${method}`)
    .digest()
    .subarray(0, 8);
}

function assertDisc(data: Buffer, method: string) {
  assert.equal(
    data.subarray(0, 8).toString("hex"),
    disc(method).toString("hex"),
  );
}

function assertU64(data: Buffer, offset: number, expected: bigint) {
  assert.equal(data.readBigUInt64LE(offset), expected);
}

function assertU16(data: Buffer, offset: number, expected: number) {
  assert.equal(data.readUInt16LE(offset), expected);
}

function main() {
  const owner = Keypair.generate().publicKey;
  const rotationAuthority = Keypair.generate().publicKey;
  const newAuthority = Keypair.generate().publicKey;
  const sourceMint = Keypair.generate().publicKey;
  const destMint = Keypair.generate().publicKey;
  const ownerAta = Keypair.generate().publicKey;
  const vaultSourceAta = Keypair.generate().publicKey;
  const vaultDestAta = Keypair.generate().publicKey;
  const feeDestination = Keypair.generate().publicKey;
  const jupiterWritable = Keypair.generate().publicKey;
  const jupiterReadonly = Keypair.generate().publicKey;

  const [vault, bump] = deriveVault(owner);
  const [expectedVault, expectedBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    STAKE_ROTATOR_PROGRAM_ID,
  );
  assert.equal(vault.toBase58(), expectedVault.toBase58());
  assert.equal(bump, expectedBump);

  const init = ixInitVault(owner, rotationAuthority, 500);
  assert.equal(init.programId.toBase58(), STAKE_ROTATOR_PROGRAM_ID.toBase58());
  assert.deepEqual(
    init.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [vault.toBase58(), false, true],
      [owner.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  );
  assertDisc(init.data, "init_vault");
  assert.equal(
    init.data.subarray(8, 40).toString("hex"),
    rotationAuthority.toBuffer().toString("hex"),
  );
  assertU16(init.data, 40, 500);

  const deposit = ixDepositLst(
    owner,
    sourceMint,
    ownerAta,
    vaultSourceAta,
    42n,
  );
  assertDisc(deposit.data, "deposit_lst");
  assertU64(deposit.data, 8, 42n);
  assert.equal(deposit.keys[5]?.pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());

  const withdraw = ixWithdrawLst(
    owner,
    sourceMint,
    ownerAta,
    vaultSourceAta,
    7n,
  );
  assertDisc(withdraw.data, "withdraw_lst");
  assertU64(withdraw.data, 8, 7n);
  assert.equal(
    withdraw.keys[5]?.pubkey.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
  );

  const revoke = ixRevokeAuthority(owner);
  assertDisc(revoke.data, "revoke_authority");
  assert.equal(revoke.keys[0]?.pubkey.toBase58(), vault.toBase58());
  assert.equal(revoke.keys[1]?.isSigner, true);

  const setAuthority = ixSetRotationAuthority(owner, newAuthority);
  assertDisc(setAuthority.data, "set_rotation_authority");
  assert.equal(
    setAuthority.data.subarray(8, 40).toString("hex"),
    newAuthority.toBuffer().toString("hex"),
  );

  const swapData = Uint8Array.from([1, 2, 3, 4]);
  const execute = ixExecuteRotation(
    owner,
    rotationAuthority,
    sourceMint,
    destMint,
    vaultSourceAta,
    vaultDestAta,
    swapData,
    99n,
    [
      { pubkey: vault, isSigner: true, isWritable: true },
      { pubkey: jupiterWritable, isSigner: false, isWritable: true },
      { pubkey: jupiterReadonly, isSigner: false, isWritable: false },
    ],
  );
  assertDisc(execute.data, "execute_rotation");
  assert.equal(execute.data.readUInt32LE(8), swapData.length);
  assert.deepEqual([...execute.data.subarray(12, 16)], [...swapData]);
  assertU64(execute.data, 16, 99n);
  assert.equal(
    execute.keys[6]?.pubkey.toBase58(),
    JUPITER_V6_PROGRAM_ID.toBase58(),
  );
  assert.equal(execute.keys[8]?.pubkey.toBase58(), vault.toBase58());
  assert.equal(execute.keys[8]?.isSigner, true);

  const claim = ixClaimPerfFee(
    owner,
    rotationAuthority,
    destMint,
    vaultDestAta,
    feeDestination,
    1_050_000_000n,
    250,
  );
  assertDisc(claim.data, "claim_performance_fee");
  assertU64(claim.data, 8, 1_050_000_000n);
  assertU16(claim.data, 16, 250);
  assert.equal(claim.keys[5]?.pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());

  console.log("vault client smoke tests passed");
}

main();
