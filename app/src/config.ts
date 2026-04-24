import { PublicKey } from "@solana/web3.js";

export const RPC_URL = "https://api.devnet.solana.com";
export const CLUSTER_OFFSET = 456;
export const PROGRAM_ID = new PublicKey(
  "F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa"
);
// The canonical benchmark PDA created during setup (admin = B6MtVeqn…zPt7)
export const BENCHMARK_ADMIN = new PublicKey(
  "B6MtVeqn7BrJ8HTX6CeP8VugNWyCqqbfcDMxYBknzPt7"
);
export const BENCHMARK_PDA = new PublicKey(
  "Gg2tunEu6NNU6TeWuQ5mydqAsSbj9NrEQSWmA45Kkj2R"
);
