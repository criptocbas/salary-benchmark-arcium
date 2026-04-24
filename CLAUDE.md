# Salary Benchmark — Project Guidance for Claude

This is an Arcium MPC dApp on Solana devnet. See `README.md` for the user-facing overview.

## Deployed state (devnet)

- Program: `F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa`
- Cluster offset: `456`
- Benchmark admin: `B6MtVeqn7BrJ8HTX6CeP8VugNWyCqqbfcDMxYBknzPt7` (= `~/.config/solana/id.json`)
- Benchmark PDA: `Gg2tunEu6NNU6TeWuQ5mydqAsSbj9NrEQSWmA45Kkj2R`
- Circuits URL base: `https://raw.githubusercontent.com/criptocbas/salary-benchmark-circuits/main/`

## The three layers (each edit has consequences)

| Layer | Path | Edit impact |
|---|---|---|
| Arcis circuits | `encrypted-ixs/src/lib.rs` | Requires `arcium build` → push new `.arcis` to circuits repo → redeploy program (`circuit_hash!` changes) |
| Solana program | `programs/salary-benchmark/src/lib.rs` | Requires `arcium build` + `arcium deploy` (or `anchor upgrade`) |
| Frontend | `app/src/` | Vite HMR, no redeploy |

**Never edit a circuit without planning to redeploy.** The `circuit_hash!` macro bakes the local `.arcis` file hash into the program `.so` at compile time. If the program's baked hash disagrees with what the MXE fetches from GitHub, `init_comp_def` fails at hash verification.

## Version alignment (critical)

Every Arcium component must be on the same version. Current: **0.9.0**.

```toml
# Cargo.toml
arcium-client = "0.9.0"
arcium-macros = "0.9.0"
arcium-anchor = "0.9.0"
# encrypted-ixs/Cargo.toml
arcis = "0.9.0"
```
```json
// package.json + app/package.json
"@arcium-hq/client": "0.9.0"
```

If callbacks fail with `Custom(102)` (InstructionDidNotDeserialize), it's a version mismatch — check CLI (`arcium --version`), Rust crates, and the TS SDK.

## Non-obvious gotchas from our build-out

### 1. `awaitComputationFinalization` can return a failed duplicate-callback sig

The MPC cluster races multiple nodes to submit the callback. First one lands, the rest fail with `AlreadyCallbackedComputation` (error 6204). The SDK's finalize-sig can point to a failed one. **Do not parse event logs from the sig `awaitComputationFinalization` returns directly.** Instead, scan `getSignaturesForAddress(computationAccount)` and find the successful callback. See `app/src/arcium.ts::revealAverage` for the pattern.

### 2. `readable-stream@2` crashes in the browser

Several Solana/Anchor deps transitively pull in `readable-stream@2` (via `hash-base` → `create-hash`), which crashes at module-load in browsers because it touches `process.stdout._writableState.slice`. Fix: alias all `readable-stream` imports to the top-level v3 browser build. See `app/vite.config.ts` — the resolve aliases are load-bearing; don't remove them.

### 3. `@solana/web3.js` must stay pinned to 1.91.9

1.92+ changes `SendTransactionError`'s constructor, which Anchor 0.32.1 uses via the old API. Symptoms: real RPC errors show up as `"Unknown action 'undefined'"`. Pin is in the root `package.json` `resolutions` field and in `app/package.json`.

### 4. Benchmark PDA is keyed by admin

The PDA is `["benchmark", admin.pubkey()]`. The frontend hardcodes the canonical admin's PDA — any wallet can *submit* to it, but only the admin wallet can *initialize* a fresh one. If the benchmark PDA needs to be re-created (e.g. after a test/reset), only `B6MtVeqn…zPt7` can sign `init_benchmark`.

### 5. `arcium test` is broken on current CLI versions

It cleans `[[test.validator.account]]` from `Anchor.toml` but doesn't re-add them. Use `arcium localnet` in one terminal + mocha in another:

```bash
arcium build
arcium localnet                    # adds Anchor.toml entries, keeps running
# new terminal:
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
ARCIUM_CLUSTER_OFFSET=0 \
yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'
```

### 6. `cargo clean` destroys the program ID

Deleting `target/deploy/salary_benchmark-keypair.json` regenerates a fresh keypair → new program ID → all PDA derivations break. **Never `cargo clean` this project.**

### 7. Linux devnet testing

- UFW: `sudo ufw allow from 172.17.0.0/16 && sudo ufw allow from 172.20.0.0/16` (Docker bridges for localnet — irrelevant on pure devnet but needed for `arcium localnet`)
- File descriptors: `sudo prlimit --pid $$ --nofile=1048576:1048576` before `arcium localnet`

## Common tasks

### Change a circuit

1. Edit `encrypted-ixs/src/lib.rs`.
2. `arcium build` → regenerates `build/*.arcis`, updates `circuit_hash!` values.
3. Push updated `.arcis` files to `criptocbas/salary-benchmark-circuits`:
   ```bash
   cd /tmp && gh repo clone criptocbas/salary-benchmark-circuits circs
   cp <repo>/build/*.arcis circs/
   cd circs && git add . && git commit -m "..." && git push
   ```
4. Wait ~5 min for `raw.githubusercontent.com` CDN to update.
5. Redeploy program:
   ```bash
   arcium deploy --keypair-path ~/.config/solana/id.json \
     --cluster-offset 456 --recovery-set-size 4 \
     --program-keypair target/deploy/salary_benchmark-keypair.json \
     --program-name salary_benchmark -u d
   ```
6. If new comp defs: re-run `scripts/setup-devnet.ts`.

### Change frontend only

Just edit under `app/src/` — Vite HMR handles the rest. `app/src/config.ts` has all the on-chain addresses.

### Add a new wallet adapter

Edit `app/src/WalletProvider.tsx` and add to the `wallets` array. The flow has been verified on Backpack (via wallet-standard auto-detect), Phantom, Solflare.

## Testing on devnet from the browser

1. `cd app && yarn dev`
2. Open http://127.0.0.1:5173
3. Connect wallet set to devnet (needs ~0.02 SOL per submission).
4. Submit → watch `participantCount` increment on screen (~30–90s for MPC).
5. Reveal → plaintext average appears.

## When debugging on-chain

- Queue tx has the `QueueComputation` log line.
- Callback tx has `CallbackComputation` + our handler's `Instruction: <name>Callback` line.
- `Program data: <base64>` lines are emitted events — first 8 bytes are the Anchor discriminator, remaining bytes are the borsh-serialised event struct.
- Duplicate callbacks (error 6204) are *expected* and *benign* — only the first one lands.

## Links

- Arcium docs: https://docs.arcium.com
- Arcium TS SDK: https://ts.arcium.com/api
- Upstream examples: https://github.com/arcium-hq/examples
- This repo's circuits repo: https://github.com/criptocbas/salary-benchmark-circuits
