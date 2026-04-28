use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Per-submission cap in cents ($10M/year). Real salaries fall well below
    /// this; the cap exists to bound the impact of a single griefer who
    /// submits an enormous value to skew the average. Above-cap values are
    /// silently clamped — the secret comparison compiles to a multiplexer,
    /// so both branches execute regardless.
    const MAX_SALARY_CENTS: u64 = 1_000_000_000;

    /// A single salary submission.
    pub struct SalaryInput {
        pub salary: u64,
    }

    /// Accumulated benchmark statistics: running total and participant count.
    pub struct BenchmarkStats {
        pub total: u64,
        pub count: u64,
    }

    /// Initialize benchmark state with zeroed totals.
    /// Returns MXE-encrypted BenchmarkStats for persistent on-chain storage.
    #[instruction]
    pub fn init_benchmark() -> Enc<Mxe, BenchmarkStats> {
        let stats = BenchmarkStats { total: 0, count: 0 };
        Mxe::get().from_arcis(stats)
    }

    /// Add an encrypted salary to the running benchmark, clamped to
    /// MAX_SALARY_CENTS. Caller's `participant_count` PDA field stays in lock-
    /// step with `count` here (every successful callback bumps both by one).
    #[instruction]
    pub fn submit_salary(
        salary: Enc<Shared, SalaryInput>,
        stats: Enc<Mxe, BenchmarkStats>,
    ) -> Enc<Mxe, BenchmarkStats> {
        let raw = salary.to_arcis().salary;
        let clamped = if raw > MAX_SALARY_CENTS { MAX_SALARY_CENTS } else { raw };

        let mut current = stats.to_arcis();
        current.total += clamped;
        current.count += 1;
        stats.owner.from_arcis(current)
    }

    /// Reveal the running total and count as plaintext. The client divides
    /// total/count to display the average.
    ///
    /// We reveal both fields (rather than just total) for two reasons:
    /// 1. The compiler optimizes away unused encrypted inputs and warns when
    ///    we pass a struct field we never read.
    /// 2. Returning the encrypted-state count gives the frontend a sanity
    ///    check against the on-chain plaintext `participant_count`. They
    ///    must agree — disagreement signals a bug.
    /// No privacy is lost: count is already public on-chain.
    ///
    /// Doing the division client-side avoids the most expensive op in Arcis
    /// (in-MPC division), at zero privacy cost.
    #[instruction]
    pub fn reveal_total(stats: Enc<Mxe, BenchmarkStats>) -> (u64, u64) {
        let s = stats.to_arcis();
        (s.total.reveal(), s.count.reveal())
    }
}
