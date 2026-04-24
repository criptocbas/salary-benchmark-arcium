import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection } from "@solana/web3.js";
import {
  fetchBenchmark,
  submitSalary,
  revealAverage,
} from "./arcium";
import { BENCHMARK_PDA, CLUSTER_OFFSET, PROGRAM_ID } from "./config";

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

  const onSubmit = async () => {
    if (!wallet.publicKey) return;
    const dollars = Number(salary);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      log("Invalid salary amount", "err");
      return;
    }
    const cents = BigInt(Math.round(dollars * 100));

    setSubmitting(true);
    log(`Encrypting & queuing salary $${dollars.toLocaleString()} ($${cents}¢)...`);
    try {
      const res = await submitSalary(
        connection as Connection,
        wallet as any,
        cents
      );
      log(`Queue tx: ${res.queueSig}`, "ok");
      log(`Finalize tx: ${res.finalizeSig}`, "ok");
      log(`Participant count now: ${res.participantCount}`, "ok");
      await refresh();
      setSalary("");
    } catch (e: any) {
      log(`Submit failed: ${e.message ?? e}`, "err");
    } finally {
      setSubmitting(false);
    }
  };

  const onReveal = async () => {
    if (!wallet.publicKey) return;
    setRevealing(true);
    setRevealed(null);
    log("Queuing reveal_average computation...");
    try {
      const res = await revealAverage(
        connection as Connection,
        wallet as any,
        (msg) => log(msg, "ok")
      );
      log(`Callback tx: ${res.finalizeSig}`, "ok");
      const dollars = Number(res.averageCents) / 100;
      log(`Revealed average: $${dollars.toLocaleString()}`, "ok");
      setRevealed(res.averageCents);
    } catch (e: any) {
      log(`Reveal failed: ${e.message ?? e}`, "err");
    } finally {
      setRevealing(false);
    }
  };

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
            <dd className="big">{bench.participantCount}</dd>
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
          no node ever sees your plaintext.
        </p>
        <div className="row">
          <input
            type="number"
            min={1}
            placeholder="Annual salary (USD)"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            disabled={!wallet.connected || submitting}
          />
          <button
            onClick={onSubmit}
            disabled={!wallet.connected || submitting || !salary}
          >
            {submitting ? "Encrypting & submitting…" : "Submit encrypted"}
          </button>
        </div>
        {!wallet.connected && (
          <p className="muted small">Connect a wallet to submit.</p>
        )}
      </section>

      <section className="card">
        <h2>2. Reveal public average</h2>
        <p className="muted">
          Anyone can trigger the reveal. The MXE computes{" "}
          <code>total / count</code> and emits the plaintext result on-chain.
        </p>
        <div className="row">
          <button
            onClick={onReveal}
            disabled={
              !wallet.connected ||
              revealing ||
              !bench ||
              bench.participantCount === 0
            }
          >
            {revealing ? "Computing…" : "Reveal average"}
          </button>
          {revealed !== null && (
            <div className="big">
              ${Number(Number(revealed) / 100).toLocaleString()}
            </div>
          )}
        </div>
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
