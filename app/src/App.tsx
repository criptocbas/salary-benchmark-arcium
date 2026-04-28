import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection } from "@solana/web3.js";
import {
  fetchBenchmark,
  submitSalary,
  revealAverage,
  hasWalletSubmitted,
  isAlreadySubmittedError,
  isInsufficientParticipantsError,
} from "./arcium";
import { BENCHMARK_PDA, CLUSTER_OFFSET, PROGRAM_ID } from "./config";

/// Mirror the program's MIN_PARTICIPANTS_FOR_REVEAL so we can gate the UI
/// before bothering the chain. The program enforces this; the UI just
/// avoids a wasted tx and a confusing error.
const MIN_PARTICIPANTS_FOR_REVEAL = 10;

/// Mirror MAX_SALARY_CENTS for input validation. Submissions above this
/// are silently clamped by the circuit; warning the user up-front is kinder.
const MAX_SALARY_DOLLARS = 10_000_000;

type BenchmarkState = {
  admin: string;
  initialized: boolean;
  participantCount: number;
};

type LogEntry = { ts: number; level: "info" | "ok" | "err"; msg: string };

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [bench, setBench] = useState<BenchmarkState | null>(null);
  const [salary, setSalary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState<bigint | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [alreadySubmitted, setAlreadySubmitted] = useState<boolean>(false);

  const log = useCallback((msg: string, level: LogEntry["level"] = "info") => {
    setLogs((prev) => [...prev, { ts: Date.now(), level, msg }]);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const b = await fetchBenchmark(connection);
      setBench(b);
    } catch (e: any) {
      log(`fetchBenchmark failed: ${e.message ?? e}`, "err");
    }
  }, [connection, log]);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 5000);
    return () => clearInterval(i);
  }, [refresh]);

  // Check whether the connected wallet has already submitted.
  useEffect(() => {
    if (!wallet.publicKey) {
      setAlreadySubmitted(false);
      return;
    }
    let cancelled = false;
    hasWalletSubmitted(connection, wallet.publicKey).then((v) => {
      if (!cancelled) setAlreadySubmitted(v);
    });
    return () => {
      cancelled = true;
    };
  }, [connection, wallet.publicKey]);

  const onSubmit = async () => {
    if (!wallet.publicKey) return;
    const dollars = Number(salary);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      log("Invalid salary amount", "err");
      return;
    }
    if (dollars > MAX_SALARY_DOLLARS) {
      log(
        `Salary exceeds clamp (${MAX_SALARY_DOLLARS.toLocaleString()}). Will be clamped — submit anyway?`,
        "err"
      );
      // Don't block; the circuit handles it. Just inform.
    }
    // Math.round: $0.005 rounds up to 1¢; sub-cent precision is dropped on purpose.
    const cents = BigInt(Math.round(dollars * 100));

    setRevealed(null); // stale once a new submission lands
    setSubmitting(true);
    log(`Encrypting & queuing salary $${dollars.toLocaleString()} (${cents}¢)...`);
    try {
      const res = await submitSalary(
        connection as Connection,
        wallet as any,
        cents
      );
      log(`Queue tx: ${res.queueSig}`, "ok");
      log(`Finalize tx: ${res.finalizeSig}`, "ok");
      log(`Participant count now: ${res.participantCount}`, "ok");
      setAlreadySubmitted(true);
      await refresh();
      setSalary("");
    } catch (e: any) {
      if (isAlreadySubmittedError(e)) {
        log("This wallet has already submitted. Use a different wallet to add another datapoint.", "err");
        setAlreadySubmitted(true);
      } else {
        log(`Submit failed: ${e.message ?? e}`, "err");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onReveal = async () => {
    if (!wallet.publicKey) return;
    setRevealing(true);
    setRevealed(null);
    log("Queuing reveal_total computation...");
    try {
      const res = await revealAverage(
        connection as Connection,
        wallet as any,
        (msg) => log(msg, "ok")
      );
      log(`Callback tx: ${res.finalizeSig}`, "ok");
      const dollars = Number(res.averageCents) / 100;
      log(
        `Revealed: total $${(Number(res.totalCents) / 100).toLocaleString()} / ${res.count} = avg $${dollars.toLocaleString()}`,
        "ok"
      );
      // Sanity check vs on-chain plaintext count.
      if (bench && Number(res.count) !== bench.participantCount) {
        log(
          `Warning: encrypted count (${res.count}) != on-chain participant_count (${bench.participantCount})`,
          "err"
        );
      }
      setRevealed(res.averageCents);
    } catch (e: any) {
      if (isInsufficientParticipantsError(e)) {
        log(
          `Need at least ${MIN_PARTICIPANTS_FOR_REVEAL} participants before reveal — protects against pairwise inference.`,
          "err"
        );
      } else {
        log(`Reveal failed: ${e.message ?? e}`, "err");
      }
    } finally {
      setRevealing(false);
    }
  };

  const participantsNeeded = bench
    ? Math.max(0, MIN_PARTICIPANTS_FOR_REVEAL - bench.participantCount)
    : MIN_PARTICIPANTS_FOR_REVEAL;
  const canReveal =
    wallet.connected &&
    !revealing &&
    bench !== null &&
    bench.participantCount >= MIN_PARTICIPANTS_FOR_REVEAL;

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>Salary Benchmark</h1>
          <p className="sub">
            Encrypted aggregation on Solana devnet via{" "}
            <a href="https://arcium.com" target="_blank" rel="noreferrer">
              Arcium
            </a>
          </p>
        </div>
        <WalletMultiButton />
      </header>

      <section className="card">
        <h2>Benchmark state</h2>
        {bench ? (
          <dl>
            <dt>Admin</dt>
            <dd className="mono">{bench.admin}</dd>
            <dt>Benchmark PDA</dt>
            <dd className="mono">{BENCHMARK_PDA.toBase58()}</dd>
            <dt>Participants</dt>
            <dd className="big">
              {bench.participantCount}
              {participantsNeeded > 0 && (
                <span className="muted small">
                  {" "}
                  ({participantsNeeded} more needed for reveal)
                </span>
              )}
            </dd>
            <dt>Status</dt>
            <dd>{bench.initialized ? "initialized" : "not initialized"}</dd>
          </dl>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="card">
        <h2>1. Submit your salary</h2>
        <p className="muted">
          Your salary is encrypted in your browser with a fresh x25519 key and
          submitted to the MXE. The MPC cluster adds it to the running total —
          no node ever sees your plaintext. One submission per wallet; values
          above ${MAX_SALARY_DOLLARS.toLocaleString()} are clamped.
        </p>
        <div className="row">
          <input
            type="number"
            min={1}
            placeholder="Annual salary (USD)"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            disabled={!wallet.connected || submitting || alreadySubmitted}
          />
          <button
            onClick={onSubmit}
            disabled={
              !wallet.connected ||
              submitting ||
              !salary ||
              alreadySubmitted
            }
          >
            {submitting
              ? "Encrypting & submitting…"
              : alreadySubmitted
                ? "Already submitted"
                : "Submit encrypted"}
          </button>
        </div>
        {!wallet.connected && (
          <p className="muted small">Connect a wallet to submit.</p>
        )}
        {wallet.connected && alreadySubmitted && (
          <p className="muted small">
            This wallet's contribution is already in the running total. Use a
            different wallet to add another datapoint.
          </p>
        )}
      </section>

      <section className="card">
        <h2>2. Reveal public average</h2>
        <p className="muted">
          Anyone can trigger the reveal once at least{" "}
          {MIN_PARTICIPANTS_FOR_REVEAL} wallets have submitted (k-anonymity
          threshold). The MXE returns the plaintext total + count and the
          frontend divides client-side.
        </p>
        <div className="row">
          <button onClick={onReveal} disabled={!canReveal}>
            {revealing ? "Computing…" : "Reveal average"}
          </button>
          {revealed !== null && (
            <div className="big">
              ${Number(Number(revealed) / 100).toLocaleString()}
            </div>
          )}
        </div>
        {bench && bench.participantCount < MIN_PARTICIPANTS_FOR_REVEAL && (
          <p className="muted small">
            Need {participantsNeeded} more participant
            {participantsNeeded === 1 ? "" : "s"} before reveal is allowed.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Log</h2>
        <div className="log">
          {logs.length === 0 && <span className="muted">No activity yet.</span>}
          {logs
            .slice()
            .reverse()
            .map((l, i) => (
              <div key={i} className={`log-line log-${l.level}`}>
                <span className="log-ts">
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
                <span>{l.msg}</span>
              </div>
            ))}
        </div>
      </section>

      <footer>
        <div className="muted small">
          Program <code className="mono">{PROGRAM_ID.toBase58()}</code> · cluster
          offset {CLUSTER_OFFSET}
        </div>
      </footer>
    </div>
  );
}
