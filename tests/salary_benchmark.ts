import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
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

describe("Salary Benchmark", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.SalaryBenchmark as Program<SalaryBenchmark>;
  const provider = anchor.getProvider();
  const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event) => {
        res(event);
      });
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  // Helper: derive benchmark PDA
  function getBenchmarkPDA(admin: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), admin.toBuffer()],
      program.programId
    )[0];
  }

  // Helper: init a comp def and upload circuit
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

    // Check if comp def already exists (e.g. from a previous run)
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

  // Helper: get arcium accounts for queue_computation
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

  it("Full benchmark: init -> 5 salary submissions -> reveal average", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // =====================================================================
    // Phase 1: Initialize computation definitions
    // =====================================================================
    console.log("Initializing computation definitions...");
    await initCompDef("initInitBenchmarkCompDef", "init_benchmark", owner);
    await initCompDef("initSubmitSalaryCompDef", "submit_salary", owner);
    await initCompDef("initRevealAverageCompDef", "reveal_average", owner);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );
    console.log("MXE x25519 pubkey:", mxePublicKey);

    // =====================================================================
    // Phase 2: Initialize benchmark (create zeroed encrypted state)
    // =====================================================================
    console.log("\n--- Init Benchmark ---");
    const initEventPromise = awaitEvent("benchmarkInitializedEvent");
    const initOffset = new anchor.BN(randomBytes(8), "hex");
    const benchmarkPDA = getBenchmarkPDA(owner.publicKey);

    const initSig = await program.methods
      .initBenchmark(initOffset)
      .accountsPartial({
        ...getArciumAccounts(initOffset, "init_benchmark"),
        benchmarkAccount: benchmarkPDA,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Init benchmark queue sig:", initSig);

    const initFinalize = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      initOffset,
      program.programId,
      "confirmed"
    );
    console.log("Init benchmark finalize sig:", initFinalize);

    const initEvent = await initEventPromise;
    console.log("Benchmark initialized by:", initEvent.admin.toBase58());

    // Verify benchmark account
    let benchmarkAcc = await program.account.benchmarkAccount.fetch(
      benchmarkPDA
    );
    expect(benchmarkAcc.isInitialized).to.be.true;
    expect(benchmarkAcc.participantCount).to.equal(0);
    console.log("Benchmark account initialized successfully");

    // =====================================================================
    // Phase 3: Submit 5 salaries (sequential — each must finalize first)
    // =====================================================================
    const salaries = [75000, 85000, 95000, 110000, 120000];
    // Salaries are in cents: multiply by 100
    const salariesInCents = salaries.map((s) => s * 100);

    for (let i = 0; i < salariesInCents.length; i++) {
      console.log(
        `\n--- Submit Salary #${i + 1}: $${salaries[i].toLocaleString()} ---`
      );

      const submitEventPromise = awaitEvent("salarySubmittedEvent");

      // Encrypt the salary with x25519 key exchange
      const privateKey = x25519.utils.randomSecretKey();
      const publicKey = x25519.getPublicKey(privateKey);
      const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
      const cipher = new RescueCipher(sharedSecret);

      const nonce = randomBytes(16);
      // SalaryInput has 1 field: salary (u64)
      const ciphertext = cipher.encrypt(
        [BigInt(salariesInCents[i])],
        nonce
      );

      const submitOffset = new anchor.BN(randomBytes(8), "hex");

      const submitSig = await program.methods
        .submitSalary(
          submitOffset,
          Array.from(publicKey) as any,
          new anchor.BN(deserializeLE(nonce).toString()),
          Array.from(ciphertext[0]) as any
        )
        .accountsPartial({
          ...getArciumAccounts(submitOffset, "submit_salary"),
          benchmarkAccount: benchmarkPDA,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`Submit queue sig:`, submitSig);

      const submitFinalize = await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        submitOffset,
        program.programId,
        "confirmed"
      );
      console.log(`Submit finalize sig:`, submitFinalize);

      const submitEvent = await submitEventPromise;
      console.log(
        `Participant count: ${submitEvent.participantCount}`
      );
      expect(submitEvent.participantCount).to.equal(i + 1);
    }

    // Verify final participant count
    benchmarkAcc = await program.account.benchmarkAccount.fetch(benchmarkPDA);
    expect(benchmarkAcc.participantCount).to.equal(5);
    console.log("\nAll 5 salaries submitted successfully");

    // =====================================================================
    // Phase 4: Reveal average
    // =====================================================================
    console.log("\n--- Reveal Average ---");
    const revealEventPromise = awaitEvent("averageRevealedEvent");
    const revealOffset = new anchor.BN(randomBytes(8), "hex");

    const revealSig = await program.methods
      .revealAverage(revealOffset)
      .accountsPartial({
        ...getArciumAccounts(revealOffset, "reveal_average"),
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
    console.log("Reveal finalize sig:", revealFinalize);

    const revealEvent = await revealEventPromise;
    const averageCents = Number(revealEvent.average);
    const averageDollars = averageCents / 100;

    console.log(`\nRevealed average (cents): ${averageCents}`);
    console.log(`Revealed average (dollars): $${averageDollars.toLocaleString()}`);

    // Expected: (75000 + 85000 + 95000 + 110000 + 120000) / 5 = 97000
    // In cents: (7500000 + 8500000 + 9500000 + 11000000 + 12000000) / 5 = 9700000
    const expectedCents = 9700000;
    expect(averageCents).to.equal(expectedCents);
    console.log(
      `\nSUCCESS: Average salary = $${averageDollars.toLocaleString()} (expected $97,000)`
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
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(
        `Attempt ${attempt} failed to fetch MXE public key:`,
        error
      );
    }
    if (attempt < maxRetries) {
      console.log(
        `Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
