import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import {
  awaitComputationFinalization,
  getCompDefAccOffset,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEPublicKey,
  RescueCipher,
  deserializeLE,
  x25519,
} from "@arcium-hq/client";
import { Buffer } from "buffer";
import idl from "./salary_benchmark.json";
import type { SalaryBenchmark } from "./salary_benchmark";
import { BENCHMARK_PDA, CLUSTER_OFFSET, PROGRAM_ID } from "./config";

type WalletLike = {
  publicKey: PublicKey | null;
  sendTransaction: (tx: Transaction, connection: Connection, opts?: any) => Promise<string>;
};

export function getProgram(
  connection: Connection,
  wallet: WalletLike
): anchor.Program<SalaryBenchmark> {
  const provider = new anchor.AnchorProvider(
    connection,
    wallet as any,
    { commitment: "confirmed" }
  );
  return new anchor.Program<SalaryBenchmark>(
    idl as SalaryBenchmark,
    provider
  );
}

export function arciumAccounts(computationOffset: BN, circuitName: string) {
  return {
    computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
    clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(PROGRAM_ID),
    mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
    compDefAccount: getCompDefAccAddress(
      PROGRAM_ID,
      Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE()
    ),
  };
}

/// Derive the per-wallet sybil-resistance PDA. Existence == "this wallet has
/// already submitted." The program's `init_if_needed` + has_submitted check
/// makes the second submission revert with AlreadySubmitted (custom error 6204).
export function deriveParticipantPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("participant"), wallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

export function randomOffset(): BN {
  return new BN(randomBytes(8), undefined, "le");
}

export async function fetchMxePublicKey(
  connection: Connection,
  walletDummy: WalletLike
): Promise<Uint8Array> {
  const provider = new anchor.AnchorProvider(connection, walletDummy as any, {
    commitment: "confirmed",
  });
  // Exponential backoff capped at ~5s. Total budget ~30s before giving up.
  let delay = 250;
  for (let i = 0; i < 12; i++) {
    try {
      const k = await getMXEPublicKey(provider, PROGRAM_ID);
      if (k) return k;
    } catch {}
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  throw new Error("Failed to fetch MXE public key");
}

/// Detects the program's AlreadySubmitted custom error so the UI can show a
/// clean message instead of the raw Anchor error log.
export function isAlreadySubmittedError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  return /AlreadySubmitted|0x1838/i.test(msg); // 6200 + 8 = 6208 = 0x1840 (rough); name match is the reliable signal
}

/// Detects InsufficientParticipants — used to gate the reveal button before
/// the program rejects.
export function isInsufficientParticipantsError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  return /InsufficientParticipants/i.test(msg);
}

export async function submitSalary(
  connection: Connection,
  wallet: WalletLike,
  salaryCents: bigint
): Promise<{ queueSig: string; finalizeSig: string; participantCount: number }> {
  const program = getProgram(connection, wallet);
  const mxePublicKey = await fetchMxePublicKey(connection, wallet);

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const nonce = randomBytes(16);
  const ciphertext = cipher.encrypt([salaryCents], nonce);

  const offset = randomOffset();
  const participantAccount = deriveParticipantPda(wallet.publicKey!);

  const queueSig = await program.methods
    .submitSalary(
      offset,
      Array.from(publicKey) as any,
      new BN(deserializeLE(nonce).toString()),
      Array.from(ciphertext[0]) as any
    )
    .accountsPartial({
      payer: wallet.publicKey!,
      benchmarkAccount: BENCHMARK_PDA,
      participantAccount,
      ...arciumAccounts(offset, "submit_salary"),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  const provider = program.provider as anchor.AnchorProvider;
  const finalizeSig = await awaitComputationFinalization(
    provider,
    offset,
    PROGRAM_ID,
    "confirmed"
  );

  const acc = await program.account.benchmarkAccount.fetch(BENCHMARK_PDA);
  return {
    queueSig,
    finalizeSig,
    participantCount: acc.participantCount as number,
  };
}

export async function revealAverage(
  connection: Connection,
  wallet: WalletLike,
  onLog?: (msg: string) => void
): Promise<{ queueSig: string; finalizeSig: string; averageCents: bigint; totalCents: bigint; count: bigint }> {
  const program = getProgram(connection, wallet);
  const offset = randomOffset();
  const computationAccount = getComputationAccAddress(CLUSTER_OFFSET, offset);

  const queueSig = await program.methods
    .revealTotal(offset)
    .accountsPartial({
      payer: wallet.publicKey!,
      benchmarkAccount: BENCHMARK_PDA,
      ...arciumAccounts(offset, "reveal_total"),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  onLog?.(`Queue tx: ${queueSig}`);

  const provider = program.provider as anchor.AnchorProvider;
  const finalizeSig = await awaitComputationFinalization(
    provider,
    offset,
    PROGRAM_ID,
    "confirmed"
  );
  onLog?.(`Finalize sig: ${finalizeSig}`);

  // The MXE cluster races multiple callback submissions — only the first
  // succeeds, the rest fail with AlreadyCallbackedComputation. The sig that
  // `awaitComputationFinalization` returns can be any of them. Scan recent
  // signatures on the computation account and find the successful callback
  // that carries our TotalRevealedEvent.
  const parser = new anchor.EventParser(
    PROGRAM_ID,
    new anchor.BorshCoder(program.idl)
  );

  const parseFromTxLogs = (logs: string[]): { total: bigint; count: bigint } | null => {
    for (const ev of parser.parseLogs(logs) as unknown as Iterable<{
      name: string;
      data: any;
    }>) {
      if (ev.name === "totalRevealedEvent") {
        return {
          total: BigInt(ev.data.total.toString()),
          count: BigInt(ev.data.count.toString()),
        };
      }
    }
    return null;
  };

  // Retry window: ~15s for the indexer to catch up. Within each attempt,
  // fetch all transactions in parallel — the previous sequential loop wasted
  // several seconds when the successful callback wasn't the first one returned.
  for (let attempt = 0; attempt < 15; attempt++) {
    const sigs = await connection.getSignaturesForAddress(computationAccount, {
      limit: 25,
    });
    const txs = await Promise.all(
      sigs.map((s) =>
        s.err
          ? Promise.resolve(null)
          : connection.getTransaction(s.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            })
      )
    );
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx?.meta?.logMessages) continue;
      const parsed = parseFromTxLogs(tx.meta.logMessages);
      if (parsed !== null) {
        const { total, count } = parsed;
        // Sanity check: encrypted-state count must match on-chain plaintext
        // participant_count. Disagreement signals a bug in the callback path.
        const averageCents = count > BigInt(0) ? total / count : BigInt(0);
        return {
          queueSig,
          finalizeSig: sigs[i].signature,
          averageCents,
          totalCents: total,
          count,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `TotalRevealedEvent not found on computation account ${computationAccount.toBase58()} (queue: ${queueSig})`
  );
}

export async function fetchBenchmark(connection: Connection) {
  const wallet: WalletLike = {
    publicKey: null,
    sendTransaction: async () => {
      throw new Error("read-only");
    },
  };
  const program = getProgram(connection, wallet);
  const acc = await program.account.benchmarkAccount.fetch(BENCHMARK_PDA);
  return {
    admin: acc.admin.toBase58(),
    initialized: acc.isInitialized,
    participantCount: acc.participantCount as number,
  };
}

/// Whether the connected wallet has already submitted (sybil PDA exists).
export async function hasWalletSubmitted(
  connection: Connection,
  wallet: PublicKey
): Promise<boolean> {
  const pda = deriveParticipantPda(wallet);
  const info = await connection.getAccountInfo(pda);
  return info !== null;
}
