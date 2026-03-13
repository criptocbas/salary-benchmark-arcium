use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

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
    pub fn init_benchmark(mxe: Mxe) -> Enc<Mxe, BenchmarkStats> {
        let stats = BenchmarkStats { total: 0, count: 0 };
        mxe.from_arcis(stats)
    }

    /// Add an encrypted salary to the running benchmark.
    /// Takes user's Shared-encrypted salary + MXE-encrypted running stats,
    /// returns updated MXE-encrypted stats.
    #[instruction]
    pub fn submit_salary(
        salary: Enc<Shared, SalaryInput>,
        stats: Enc<Mxe, BenchmarkStats>,
    ) -> Enc<Mxe, BenchmarkStats> {
        let input = salary.to_arcis();
        let mut current = stats.to_arcis();
        current.total += input.salary;
        current.count += 1;
        stats.owner.from_arcis(current)
    }

    /// Reveal the average salary. Computes total/count and returns plaintext.
    #[instruction]
    pub fn reveal_average(stats: Enc<Mxe, BenchmarkStats>) -> u64 {
        let s = stats.to_arcis();
        let avg = s.total / s.count;
        avg.reveal()
    }
}
