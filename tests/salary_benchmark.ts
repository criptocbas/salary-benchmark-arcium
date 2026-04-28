import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SalaryBenchmark } from "../target/types/salary_benchmark";
import { randomBytes } from "crypto";
import * as fs from "fs";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as os from "os";
import { expect } from "chai";

const MIN_PARTICIPANTS_FOR_REVEAL = 10;

describe("Salary Benchmark", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.SalaryBenchmark as Program<SalaryBenchmark>;
  const provider = anchor.getProvider();
  const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  async function getEventsFromTx(sig: string): Promise<any[]> {
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) return [];
    const eventParser = new anchor.EventParser(
      program.programId,
      new anchor.BorshCoder(program.idl)
    );
    return Array.from(
      eventParser.parseLogs(tx.meta.logMessages) as unknown as Iterable<any>
    );
  }

  function getBenchmarkPDA(admin: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), admin.toBuffer()],
      program.programId
    )[0];
  }

  function getParticipantPDA(wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), wallet.toBuffer()],
      program.programId
    )[0];
  }

  async function initCompDef(
    methodName: string,
    circuitName: string,
    owner: anchor.web3.Keypair
  ) {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset(circuitName);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot
    );

    const compDefInfo = await provider.connection.getAccountInfo(compDefPDA);
    if (compDefInfo) {
      console.log(`Comp def ${circuitName} already exists, skipping init`);
      return "already-exists";
    }

    const sig = await (program.methods as any)
      [methodName]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    console.log(`Init ${circuitName} comp def tx:`, sig);
    return sig;
  }

  function getArciumAccounts(
    computationOffset: anchor.BN,
    circuitName: string
  ) {
    return {
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(
        arciumEnv.arciumClusterOffset
      ),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE()
      ),
    };
  }

  /// Submit a salary from `submitter` (a fresh keypair). The submitter must
  /// have been airdropped enough SOL for fees + the participant PDA's rent.
  async function submitFrom(
    submitter: Keypair,
    benchmarkPDA: PublicKey,
    salaryCents: bigint,
    mxePublicKey: Uint8Array
  ): Promise<string> {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([salaryCents], nonce);

    const submitOffset = new anchor.BN(randomBytes(8), "hex");
    const sig = await program.methods
      .submitSalary(
        submitOffset,
        Array.from(publicKey) as any,
        new anchor.BN(deserializeLE(nonce).toString()),
        Array.from(ciphertext[0]) as any
      )
      .accountsPartial({
        ...getArciumAccounts(submitOffset, "submit_salary"),
        payer: submitter.publicKey,
        benchmarkAccount: benchmarkPDA,
        participantAccount: getParticipantPDA(submitter.publicKey),
      })
      .signers([submitter])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      submitOffset,
      program.programId,
      "confirmed"
    );
    return sig;
  }

  async function airdropSubmitter(): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      kp.publicKey,
      0.1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
    return kp;
  }

  it("Full benchmark: init → 10 submissions → reveal", async function () {
    this.timeout(0);

    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // ---- Phase 1: comp defs ----
    console.log("Initializing computation definitions...");
    await initCompDef("initInitBenchmarkCompDef", "init_benchmark", owner);
    await initCompDef("initSubmitSalaryCompDef", "submit_salary", owner);
    await initCompDef("initRevealTotalCompDef", "reveal_total", owner);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );
    console.log("MXE x25519 pubkey:", mxePublicKey);

    // ---- Phase 2: init benchmark ----
    console.log("\n--- Init Benchmark ---");
    const initOffset = new anchor.BN(randomBytes(8), "hex");
    const benchmarkPDA = getBenchmarkPDA(owner.publicKey);

    await program.methods
      .initBenchmark(initOffset)
      .accountsPartial({
        ...getArciumAccounts(initOffset, "init_benchmark"),
        benchmarkAccount: benchmarkPDA,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      initOffset,
      program.programId,
      "confirmed"
    );

    let benchmarkAcc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
    expect(benchmarkAcc.isInitialized).to.be.true;
    expect(benchmarkAcc.participantCount).to.equal(0);

    // ---- Phase 3: submit 9 salaries (one short of threshold) ----
    const salariesUsd = [75000, 85000, 95000, 110000, 120000, 90000, 100000, 130000, 80000];
    const submitters: Keypair[] = [];

    for (let i = 0; i < salariesUsd.length; i++) {
      console.log(`\n--- Submit #${i + 1}: $${salariesUsd[i].toLocaleString()} ---`);
      const submitter = await airdropSubmitter();
      submitters.push(submitter);
      await submitFrom(
        submitter,
        benchmarkPDA,
        BigInt(salariesUsd[i] * 100),
        mxePublicKey
      );
      benchmarkAcc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
      expect(benchmarkAcc.participantCount).to.equal(i + 1);
    }

    // ---- Phase 4: reveal must fail at 9 participants ----
    console.log("\n--- Reveal at 9 participants (should fail) ---");
    {
      const revealOffset = new anchor.BN(randomBytes(8), "hex");
      let threw = false;
      try {
        await program.methods
          .revealTotal(revealOffset)
          .accountsPartial({
            ...getArciumAccounts(revealOffset, "reveal_total"),
            benchmarkAccount: benchmarkPDA,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      } catch (e: any) {
        threw = true;
        expect(String(e.message ?? e)).to.match(/InsufficientParticipants/);
      }
      expect(threw, "reveal_total should error below k-anonymity threshold").to.be.true;
    }

    // ---- Phase 5: 10th submission unlocks reveal ----
    console.log("\n--- Submit #10 (unlocks reveal) ---");
    const submitter10 = await airdropSubmitter();
    submitters.push(submitter10);
    await submitFrom(submitter10, benchmarkPDA, BigInt(100_000 * 100), mxePublicKey);
    benchmarkAcc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
    expect(benchmarkAcc.participantCount).to.equal(MIN_PARTICIPANTS_FOR_REVEAL);

    // ---- Phase 6: sybil — same wallet can't submit twice ----
    console.log("\n--- Sybil check (re-submit from same wallet) ---");
    {
      let threw = false;
      try {
        await submitFrom(submitters[0], benchmarkPDA, BigInt(100), mxePublicKey);
      } catch (e: any) {
        threw = true;
        // Either AlreadySubmitted (our require!) or Anchor's account-already-in-use
        // depending on which fires first. Both are correct rejections.
        expect(String(e.message ?? e)).to.match(/AlreadySubmitted|already in use/);
      }
      expect(threw, "duplicate submission must be rejected").to.be.true;
    }

    // ---- Phase 7: reveal succeeds ----
    console.log("\n--- Reveal at 10 participants ---");
    const revealOffset = new anchor.BN(randomBytes(8), "hex");
    const revealSig = await program.methods
      .revealTotal(revealOffset)
      .accountsPartial({
        ...getArciumAccounts(revealOffset, "reveal_total"),
        benchmarkAccount: benchmarkPDA,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Reveal queue sig:", revealSig);

    const revealFinalize = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealOffset,
      program.programId,
      "confirmed"
    );

    const events = await getEventsFromTx(revealFinalize);
    const revealEvent = events.find((e) => e.name === "totalRevealedEvent");
    expect(revealEvent, "totalRevealedEvent should be emitted").to.not.be.undefined;

    const totalCents = Number(revealEvent!.data.total);
    const count = Number(revealEvent!.data.count);
    const averageCents = totalCents / count;

    expect(count).to.equal(MIN_PARTICIPANTS_FOR_REVEAL);

    const expectedTotal = (
      salariesUsd.reduce((a, b) => a + b, 0) + 100_000
    ) * 100;
    expect(totalCents).to.equal(expectedTotal);

    console.log(
      `\nSUCCESS: total=${totalCents}¢ count=${count} avg=$${(averageCents / 100).toLocaleString()}`
    );
  });
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch (error) {
      console.log(`Attempt ${attempt}: failed`, error);
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
