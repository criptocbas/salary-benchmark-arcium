# Salary Benchmark

Privacy-preserving salary benchmarking on Solana using [Arcium](https://arcium.com) Multi-Party Computation.

Users submit **encrypted** salaries to an on-chain program. An MPC cluster aggregates them without any single node ever seeing a plaintext value. Anyone can then reveal only the **public average** — individual salaries stay encrypted forever.

## Live on devnet

| | |
|---|---|
| Program | [`F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa`](https://explorer.solana.com/address/F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa?cluster=devnet) |
| Benchmark PDA | [`Gg2tunEu6NNU6TeWuQ5mydqAsSbj9NrEQSWmA45Kkj2R`](https://explorer.solana.com/address/Gg2tunEu6NNU6TeWuQ5mydqAsSbj9NrEQSWmA45Kkj2R?cluster=devnet) |
| Arcium cluster offset | `456` |
| Circuits | [`criptocbas/salary-benchmark-circuits`](https://github.com/criptocbas/salary-benchmark-circuits) |

## Architecture

Three layers, each in a separate directory:

```
┌──────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│  encrypted-ixs/          │   │  programs/               │   │  app/                    │
│                          │   │  salary-benchmark/       │   │                          │
│  Arcis circuits (MPC)    │──▶│  Solana program (Anchor) │──▶│  Vite + React frontend   │
│  - init_benchmark        │   │  - queue_computation     │   │  - x25519 + Rescue       │
│  - submit_salary         │   │  - callback handlers     │   │  - wallet-adapter        │
│  - reveal_average        │   │  - benchmark PDA state   │   │  - live PDA polling      │
└──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘
       run on MXE nodes              runs on-chain                   runs in browser
```

- **encrypted-ixs/** — Arcis circuits that run on the MPC cluster. Never see plaintext individually.
- **programs/salary-benchmark/** — Anchor program that queues computations and handles callbacks. Stores MXE-encrypted `(total, count)` in the benchmark PDA.
- **app/** — Vite + React frontend. Encrypts salaries locally with x25519, submits via connected wallet.

## Run the frontend locally

```bash
cd app
yarn install
yarn dev
# → http://127.0.0.1:5173
```

Connect any devnet Solana wallet (Phantom, Solflare, Backpack), submit a salary, reveal the average.

## Computation flow (one submission)

1. **Browser** generates an ephemeral x25519 keypair, derives a shared secret with the MXE, encrypts the salary with Rescue cipher.
2. **User wallet** signs `submit_salary(offset, pubkey, nonce, ciphertext)`.
3. **Arcium program** queues the computation on the MPC cluster.
4. **MXE nodes** (multi-party) run `submit_salary` circuit — each sees only a secret share of the salary, adds it to the running encrypted `(total, count)`.
5. **Callback** returns updated `(total, count)` MXE-encrypted, stored in the benchmark PDA. `participant_count` increments.

Reveal works the same way, but returns plaintext `total / count`.

## Project structure

```
.
├── app/                    # Vite + React frontend
│   ├── src/
│   │   ├── App.tsx         # main UI
│   │   ├── arcium.ts       # encryption + queue + reveal logic
│   │   ├── config.ts       # devnet program ID, PDA, cluster offset
│   │   └── WalletProvider.tsx
│   └── vite.config.ts      # includes readable-stream alias (see CLAUDE.md)
├── encrypted-ixs/
│   └── src/lib.rs          # Arcis circuits
├── programs/
│   └── salary-benchmark/
│       └── src/lib.rs      # Anchor program
├── scripts/
│   └── setup-devnet.ts     # idempotent one-time init (comp defs + benchmark)
├── tests/
│   └── salary_benchmark.ts # mocha integration tests
├── Anchor.toml             # devnet config (cluster = "devnet")
├── Arcium.toml             # cluster offset 456 for devnet
└── CLAUDE.md               # project-specific guidance for AI assistants
```

## Re-initialise (idempotent)

If comp defs or benchmark PDA ever need re-init:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
yarn ts-node scripts/setup-devnet.ts
```

The script skips anything already on-chain.

## Links

- [Arcium docs](https://docs.arcium.com)
- [Arcium TS SDK](https://ts.arcium.com/api)
- [Arcium Discord](https://discord.com/invite/arcium)

## License

MIT
