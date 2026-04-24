import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { SalaryBenchmark } from "../target/types/salary_benchmark";
import {
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";

const CLUSTER_OFFSET = 456;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SalaryBenchmark as anchor.Program<SalaryBenchmark>;
  const arciumProgram = getArciumProgram(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());

  const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

  // --- Init comp defs ---
  for (const { method, circuit } of [
    { method: "initInitBenchmarkCompDef", circuit: "init_benchmark" },
    { method: "initSubmitSalaryCompDef", circuit: "submit_salary" },
    { method: "initRevealAverageCompDef", circuit: "reveal_average" },
  ]) {
    const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset(circuit);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeed, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const existing = await provider.connection.getAccountInfo(compDefPDA);
    if (existing) {
      console.log(`[${circuit}] comp def already initialized at ${compDefPDA.toBase58()} — skipping`);
      continue;
    }

    console.log(`[${circuit}] initializing comp def at ${compDefPDA.toBase58()} ...`);
    const sig = await (program.methods as any)
      [method]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`[${circuit}] sig: ${sig}`);
  }

  // --- Init canonical benchmark (admin = payer) ---
  const benchmarkPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("benchmark"), payer.publicKey.toBuffer()],
    program.programId
  )[0];

  const existingBench = await provider.connection.getAccountInfo(benchmarkPDA);
  if (existingBench) {
    const acc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
    console.log(`Benchmark PDA already exists: ${benchmarkPDA.toBase58()}`);
    console.log(`  admin=${acc.admin.toBase58()} initialized=${acc.isInitialized} count=${acc.participantCount}`);
    if (acc.isInitialized) {
      console.log("Setup complete.");
      return;
    }
    console.log("Benchmark account exists but not finalized — skipping (delete PDA manually to retry).");
    return;
  }

  console.log(`\nInitializing benchmark PDA ${benchmarkPDA.toBase58()} ...`);
  const initOffset = new anchor.BN(randomBytes(8), "hex");
  const sig = await program.methods
    .initBenchmark(initOffset)
    .accountsPartial({
      payer: payer.publicKey,
      benchmarkAccount: benchmarkPDA,
      computationAccount: getComputationAccAddress(CLUSTER_OFFSET, initOffset),
      clusterAccount,
      mxeAccount,
      mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
      executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset("init_benchmark")).readUInt32LE()
      ),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  console.log(`init_benchmark queue sig: ${sig}`);

  console.log("Awaiting MPC finalization ...");
  const final = await awaitComputationFinalization(
    provider,
    initOffset,
    program.programId,
    "confirmed"
  );
  console.log(`Finalize sig: ${final}`);

  const acc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
  console.log(`\nBenchmark initialized.`);
  console.log(`  PDA: ${benchmarkPDA.toBase58()}`);
  console.log(`  admin: ${acc.admin.toBase58()}`);
  console.log(`  initialized: ${acc.isInitialized}`);
  console.log(`  participants: ${acc.participantCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
