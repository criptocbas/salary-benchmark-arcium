# Salary Benchmark — Frontend

Vite + React + wallet-adapter frontend for the salary-benchmark Arcium program.

## Run locally

```bash
cd app
yarn install
yarn dev
# → http://127.0.0.1:5173
```

## Devnet deployment (already done)

- Program: `F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa`
- Cluster offset: `456`
- Canonical benchmark PDA: `Gg2tunEu6NNU6TeWuQ5mydqAsSbj9NrEQSWmA45Kkj2R`
- Benchmark admin: `B6MtVeqn7BrJ8HTX6CeP8VugNWyCqqbfcDMxYBknzPt7`

## Flow

1. Connect wallet (Phantom / Solflare) set to devnet.
2. Enter annual salary → Submit encrypted.
   - Browser generates ephemeral x25519 key, derives shared secret with MXE.
   - Rescue-encrypts salary, submits `submit_salary` instruction.
   - Waits for MPC finalization (~30–90s).
   - Reads updated `participantCount` from the benchmark PDA.
3. Anyone can click Reveal average when count > 0.
   - Queues `reveal_average`, awaits finalization.
   - Parses `AverageRevealedEvent` from the callback transaction logs.

## Re-running the one-time admin setup

If you ever need to re-init comp defs or re-init the benchmark:

```bash
cd ..   # back to salary-benchmark/
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
yarn ts-node scripts/setup-devnet.ts
```
