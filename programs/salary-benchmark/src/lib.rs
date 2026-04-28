use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{
    CallbackAccount, CircuitSource, OffChainCircuitSource,
};
use arcium_macros::circuit_hash;

const COMP_DEF_OFFSET_INIT_BENCHMARK: u32 = comp_def_offset("init_benchmark");
const COMP_DEF_OFFSET_SUBMIT_SALARY: u32 = comp_def_offset("submit_salary");
const COMP_DEF_OFFSET_REVEAL_TOTAL: u32 = comp_def_offset("reveal_total");

/// k-anonymity threshold: with fewer participants, anyone who knows the prior
/// participant_count and the revealed total can subtract their own
/// contribution to learn another submitter's salary. 10 is small enough for a
/// demo while making basic pairwise inference impractical.
const MIN_PARTICIPANTS_FOR_REVEAL: u32 = 10;

/// `queue_computation` parameters from arcium-anchor 0.9.x:
/// - `num_callback_txs`: 1 (single callback transaction; the cluster races
///   multiple submissions but only the first lands).
/// - `cu_price_micro`: 0 (no extra compute-unit priority fee).
const NUM_CALLBACK_TXS: u8 = 1;
const CU_PRICE_MICRO: u64 = 0;

declare_id!("F2ELc1JwtVm75jmJtafDnxDQa7yqM78HuZ2cgcvy8Waa");

#[arcium_program]
pub mod salary_benchmark {
    use super::*;

    // =========================================================================
    // Init Computation Definitions (call once per circuit after deploy)
    // =========================================================================

    pub fn init_init_benchmark_comp_def(
        ctx: Context<InitInitBenchmarkCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/criptocbas/salary-benchmark-circuits/main/init_benchmark.arcis".to_string(),
                hash: circuit_hash!("init_benchmark"),
            })),
            None,
        )?;
        Ok(())
    }

    pub fn init_submit_salary_comp_def(
        ctx: Context<InitSubmitSalaryCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/criptocbas/salary-benchmark-circuits/main/submit_salary.arcis".to_string(),
                hash: circuit_hash!("submit_salary"),
            })),
            None,
        )?;
        Ok(())
    }

    pub fn init_reveal_total_comp_def(
        ctx: Context<InitRevealTotalCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/criptocbas/salary-benchmark-circuits/main/reveal_total.arcis".to_string(),
                hash: circuit_hash!("reveal_total"),
            })),
            None,
        )?;
        Ok(())
    }

    // =========================================================================
    // Init Benchmark — create zeroed encrypted state
    // =========================================================================

    /// Queue init_benchmark computation.
    /// init_benchmark takes only Mxe — no args needed (circuit creates zeros internally).
    pub fn init_benchmark(
        ctx: Context<InitBenchmark>,
        computation_offset: u64,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let benchmark = &mut ctx.accounts.benchmark_account;
        benchmark.admin = ctx.accounts.payer.key();
        benchmark.is_initialized = false;
        benchmark.participant_count = 0;

        let args = ArgBuilder::new().build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitBenchmarkCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.benchmark_account.key(),
                    is_writable: true,
                }],
            )?],
            NUM_CALLBACK_TXS,
            CU_PRICE_MICRO,
        )?;
        Ok(())
    }

    /// Callback for init_benchmark: stores MXE-encrypted zero state.
    #[arcium_callback(encrypted_ix = "init_benchmark")]
    pub fn init_benchmark_callback(
        ctx: Context<InitBenchmarkCallback>,
        output: SignedComputationOutputs<InitBenchmarkOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitBenchmarkOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("init_benchmark verify_output failed: {:?}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let benchmark = &mut ctx.accounts.benchmark_account;
        benchmark.is_initialized = true;
        benchmark.encrypted_nonce = o.nonce.to_le_bytes();
        benchmark.ct_total = o.ciphertexts[0];
        benchmark.ct_count = o.ciphertexts[1];

        emit!(BenchmarkInitializedEvent {
            admin: benchmark.admin,
        });
        Ok(())
    }

    // =========================================================================
    // Submit Salary — add encrypted salary to running total
    // =========================================================================

    /// Queue submit_salary computation.
    ///
    /// One submission per wallet is enforced by the `participant_account` PDA:
    /// the runtime check below errors if the wallet has already submitted.
    /// (We use init_if_needed + runtime check rather than plain init so the
    /// failure surfaces as a typed AlreadySubmitted error, not the opaque
    /// "account already in use" Anchor returns.)
    ///
    /// ArgBuilder order:
    ///   Enc<Shared, SalaryInput>: x25519_pubkey → nonce → ct_salary
    ///   Enc<Mxe, BenchmarkStats>: nonce → ct_total, ct_count
    pub fn submit_salary(
        ctx: Context<SubmitSalary>,
        computation_offset: u64,
        pubkey: [u8; 32],
        nonce: u128,
        ct_salary: [u8; 32],
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            ctx.accounts.benchmark_account.is_initialized,
            ErrorCode::BenchmarkNotInitialized
        );
        require!(
            !ctx.accounts.participant_account.has_submitted,
            ErrorCode::AlreadySubmitted
        );

        ctx.accounts.participant_account.bump = ctx.bumps.participant_account;
        ctx.accounts.participant_account.has_submitted = true;

        let benchmark = &ctx.accounts.benchmark_account;
        let stored_nonce = u128::from_le_bytes(benchmark.encrypted_nonce);

        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ct_salary)
            .plaintext_u128(stored_nonce)
            .encrypted_u64(benchmark.ct_total)
            .encrypted_u64(benchmark.ct_count)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SubmitSalaryCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.benchmark_account.key(),
                    is_writable: true,
                }],
            )?],
            NUM_CALLBACK_TXS,
            CU_PRICE_MICRO,
        )?;
        Ok(())
    }

    /// Callback for submit_salary: updates encrypted state and increments count.
    #[arcium_callback(encrypted_ix = "submit_salary")]
    pub fn submit_salary_callback(
        ctx: Context<SubmitSalaryCallback>,
        output: SignedComputationOutputs<SubmitSalaryOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SubmitSalaryOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("submit_salary verify_output failed: {:?}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let benchmark = &mut ctx.accounts.benchmark_account;
        benchmark.encrypted_nonce = o.nonce.to_le_bytes();
        benchmark.ct_total = o.ciphertexts[0];
        benchmark.ct_count = o.ciphertexts[1];
        benchmark.participant_count = benchmark.participant_count.checked_add(1).unwrap();

        emit!(SalarySubmittedEvent {
            participant_count: benchmark.participant_count,
        });
        Ok(())
    }

    // =========================================================================
    // Reveal Total — reveal plaintext total; client computes total / count
    // =========================================================================

    /// Queue reveal_total computation.
    /// Gated on MIN_PARTICIPANTS_FOR_REVEAL for k-anonymity.
    pub fn reveal_total(
        ctx: Context<RevealTotal>,
        computation_offset: u64,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            ctx.accounts.benchmark_account.is_initialized,
            ErrorCode::BenchmarkNotInitialized
        );
        require!(
            ctx.accounts.benchmark_account.participant_count >= MIN_PARTICIPANTS_FOR_REVEAL,
            ErrorCode::InsufficientParticipants
        );

        let benchmark = &ctx.accounts.benchmark_account;
        let stored_nonce = u128::from_le_bytes(benchmark.encrypted_nonce);

        let args = ArgBuilder::new()
            .plaintext_u128(stored_nonce)
            .encrypted_u64(benchmark.ct_total)
            .encrypted_u64(benchmark.ct_count)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealTotalCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            NUM_CALLBACK_TXS,
            CU_PRICE_MICRO,
        )?;
        Ok(())
    }

    /// Callback for reveal_total: emits the plaintext (total, count).
    /// The macro flattens tuple returns into a nested struct
    /// (`RevealTotalOutput.field_0` is `RevealTotalOutputStruct0` whose
    /// `field_0`/`field_1` are the tuple elements).
    #[arcium_callback(encrypted_ix = "reveal_total")]
    pub fn reveal_total_callback(
        ctx: Context<RevealTotalCallback>,
        output: SignedComputationOutputs<RevealTotalOutput>,
    ) -> Result<()> {
        let (total, count) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealTotalOutput { field_0: inner }) => (inner.field_0, inner.field_1),
            Err(e) => {
                msg!("reveal_total verify_output failed: {:?}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        emit!(TotalRevealedEvent { total, count });
        Ok(())
    }
}

// =============================================================================
// Account Structs
// =============================================================================

#[account]
#[derive(InitSpace)]
pub struct BenchmarkAccount {
    pub admin: Pubkey,
    pub is_initialized: bool,
    pub participant_count: u32,
    pub encrypted_nonce: [u8; 16],
    pub ct_total: [u8; 32],
    pub ct_count: [u8; 32],
}

/// One per submitter. Existence + `has_submitted` enforce one submission per
/// wallet. Sybil resistance is best-effort — a determined attacker can use
/// many wallets, but each one costs gas and a (refundable) PDA rent deposit.
#[account]
#[derive(InitSpace)]
pub struct ParticipantAccount {
    pub bump: u8,
    pub has_submitted: bool,
}

// =============================================================================
// Init Computation Definition Account Structs
// =============================================================================

#[init_computation_definition_accounts("init_benchmark", payer)]
#[derive(Accounts)]
pub struct InitInitBenchmarkCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("submit_salary", payer)]
#[derive(Accounts)]
pub struct InitSubmitSalaryCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_total", payer)]
#[derive(Accounts)]
pub struct InitRevealTotalCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// =============================================================================
// Queue Computation Account Structs
// =============================================================================

#[queue_computation_accounts("init_benchmark", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitBenchmark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BENCHMARK))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + BenchmarkAccount::INIT_SPACE,
        seeds = [b"benchmark", payer.key().as_ref()],
        bump,
    )]
    pub benchmark_account: Account<'info, BenchmarkAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("submit_salary", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitSalary<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_SALARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(
        mut,
        seeds = [b"benchmark", benchmark_account.admin.as_ref()],
        bump,
    )]
    pub benchmark_account: Box<Account<'info, BenchmarkAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ParticipantAccount::INIT_SPACE,
        seeds = [b"participant", payer.key().as_ref()],
        bump,
    )]
    pub participant_account: Account<'info, ParticipantAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("reveal_total", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RevealTotal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TOTAL))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(
        seeds = [b"benchmark", benchmark_account.admin.as_ref()],
        bump,
    )]
    pub benchmark_account: Account<'info, BenchmarkAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

// =============================================================================
// Callback Account Structs
// =============================================================================

#[callback_accounts("init_benchmark")]
#[derive(Accounts)]
pub struct InitBenchmarkCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BENCHMARK))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub benchmark_account: Account<'info, BenchmarkAccount>,
}

#[callback_accounts("submit_salary")]
#[derive(Accounts)]
pub struct SubmitSalaryCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_SALARY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub benchmark_account: Account<'info, BenchmarkAccount>,
}

#[callback_accounts("reveal_total")]
#[derive(Accounts)]
pub struct RevealTotalCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TOTAL))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
}

// =============================================================================
// Events
// =============================================================================

#[event]
pub struct BenchmarkInitializedEvent {
    pub admin: Pubkey,
}

#[event]
pub struct SalarySubmittedEvent {
    pub participant_count: u32,
}

#[event]
pub struct TotalRevealedEvent {
    pub total: u64,
    pub count: u64,
}

// =============================================================================
// Errors
// =============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Benchmark not initialized")]
    BenchmarkNotInitialized,
    #[msg("Not enough participants for reveal (k-anonymity threshold)")]
    InsufficientParticipants,
    #[msg("This wallet has already submitted a salary")]
    AlreadySubmitted,
}
