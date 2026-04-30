// Stake Rotator — non-custodial LST rotation vault.
//
// Trust model:
// - Owner controls the vault PDA (seeds = [b"vault", owner]). Owner can deposit,
//   withdraw, change or revoke the rotation_authority at any time. Revoke is the
//   kill-switch (Pubkey::default sentinel).
// - rotation_authority (the bot keypair) can call `execute_rotation` to forward an
//   arbitrary Jupiter v6 swap instruction via invoke_signed with the vault PDA as
//   the swap signer. Security relies on (a) the Jupiter program ID being pinned,
//   (b) the bot's `min_out_amount` slippage check, (c) the owner's revoke option.
// - `claim_performance_fee` accepts current_sol_value_per_lst from the bot. A
//   production version should read this from Sanctum's on-chain pool state. The
//   `perf_fee_bps_max` cap on Vault limits worst-case fee draw.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("RotatoR1111111111111111111111111111111111111");

const VAULT_SEED: &[u8] = b"vault";
const LAMPORTS_PER_SOL_U128: u128 = 1_000_000_000;

// Jupiter v6 aggregator program ID.
pub const JUPITER_V6_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

#[program]
pub mod stake_rotator {
    use super::*;

    pub fn init_vault(
        ctx: Context<InitVault>,
        rotation_authority: Pubkey,
        perf_fee_bps_max: u16,
    ) -> Result<()> {
        require!(perf_fee_bps_max <= 2000, ErrorCode::FeeBpsTooHigh);
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.rotation_authority = rotation_authority;
        v.current_lst_mint = Pubkey::default();
        v.baseline_amount = 0;
        v.high_water_mark_lamports = 0;
        v.last_rotation_slot = 0;
        v.perf_fee_bps_max = perf_fee_bps_max;
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit_lst(ctx: Context<DepositLst>, amount: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        let mint_key = ctx.accounts.lst_mint.key();
        if v.current_lst_mint == Pubkey::default() {
            v.current_lst_mint = mint_key;
        } else {
            require_keys_eq!(v.current_lst_mint, mint_key, ErrorCode::WrongMint);
        }
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        v.baseline_amount = v.baseline_amount.saturating_add(amount);
        Ok(())
    }

    pub fn withdraw_lst(ctx: Context<WithdrawLst>, amount: u64) -> Result<()> {
        let owner_key = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        require_keys_eq!(
            ctx.accounts.lst_mint.key(),
            ctx.accounts.vault.current_lst_mint,
            ErrorCode::WrongMint
        );
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        let v = &mut ctx.accounts.vault;
        v.baseline_amount = v.baseline_amount.saturating_sub(amount);
        Ok(())
    }

    pub fn set_rotation_authority(
        ctx: Context<UpdateAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.vault.rotation_authority = new_authority;
        Ok(())
    }

    /// Kill-switch: owner-only. Sets rotation_authority to Pubkey::default(),
    /// after which `execute_rotation` and `claim_performance_fee` will both fail.
    pub fn revoke_authority(ctx: Context<UpdateAuthority>) -> Result<()> {
        ctx.accounts.vault.rotation_authority = Pubkey::default();
        Ok(())
    }

    /// Forwards a pre-built Jupiter v6 swap instruction signed by the vault PDA.
    /// `remaining_accounts` MUST be the full account list Jupiter expects, in order.
    pub fn execute_rotation(
        ctx: Context<ExecuteRotation>,
        swap_data: Vec<u8>,
        min_out_amount: u64,
    ) -> Result<()> {
        {
            let v = &ctx.accounts.vault;
            require!(
                v.rotation_authority != Pubkey::default(),
                ErrorCode::AuthorityRevoked
            );
            require_keys_eq!(
                v.rotation_authority,
                ctx.accounts.rotation_authority.key(),
                ErrorCode::NotAuthorized
            );
            require_keys_eq!(
                v.current_lst_mint,
                ctx.accounts.source_mint.key(),
                ErrorCode::WrongMint
            );
        }

        let pre_source = ctx.accounts.vault_source_account.amount;
        let pre_dest = ctx.accounts.vault_dest_account.amount;

        let mut metas = Vec::with_capacity(ctx.remaining_accounts.len());
        let mut infos = Vec::with_capacity(ctx.remaining_accounts.len());
        for acc in ctx.remaining_accounts.iter() {
            metas.push(if acc.is_writable {
                AccountMeta::new(*acc.key, acc.is_signer)
            } else {
                AccountMeta::new_readonly(*acc.key, acc.is_signer)
            });
            infos.push(acc.clone());
        }
        let ix = Instruction {
            program_id: JUPITER_V6_PROGRAM_ID,
            accounts: metas,
            data: swap_data,
        };

        let owner_key = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];
        invoke_signed(&ix, &infos, seeds)?;

        ctx.accounts.vault_source_account.reload()?;
        ctx.accounts.vault_dest_account.reload()?;
        let post_source = ctx.accounts.vault_source_account.amount;
        let post_dest = ctx.accounts.vault_dest_account.amount;

        require!(post_source < pre_source, ErrorCode::SourceUnchanged);
        let received = post_dest
            .checked_sub(pre_dest)
            .ok_or(ErrorCode::SwapMathOverflow)?;
        require!(received >= min_out_amount, ErrorCode::SlippageExceeded);

        let v = &mut ctx.accounts.vault;
        v.current_lst_mint = ctx.accounts.dest_mint.key();
        v.baseline_amount = post_dest;
        v.last_rotation_slot = Clock::get()?.slot;
        Ok(())
    }

    /// Compute uplift over high-water-mark in SOL terms and transfer fee_bps of it
    /// from the vault token account to fee_destination, in current LST units.
    /// `current_sol_value_per_lst` is in lamports per 1 LST (scaled by 1e9 native).
    pub fn claim_performance_fee(
        ctx: Context<ClaimPerfFee>,
        current_sol_value_per_lst: u64,
        fee_bps: u16,
    ) -> Result<()> {
        let v = &ctx.accounts.vault;
        require!(
            v.rotation_authority != Pubkey::default(),
            ErrorCode::AuthorityRevoked
        );
        require_keys_eq!(
            v.rotation_authority,
            ctx.accounts.rotation_authority.key(),
            ErrorCode::NotAuthorized
        );
        require!(fee_bps <= v.perf_fee_bps_max, ErrorCode::FeeBpsTooHigh);
        require_keys_eq!(
            v.current_lst_mint,
            ctx.accounts.current_lst_mint.key(),
            ErrorCode::WrongMint
        );
        require!(current_sol_value_per_lst > 0, ErrorCode::InvalidOracleValue);

        let lst_balance = ctx.accounts.vault_token_account.amount;
        let nav_lamports: u64 = ((lst_balance as u128)
            .checked_mul(current_sol_value_per_lst as u128)
            .ok_or(ErrorCode::SwapMathOverflow)?
            / LAMPORTS_PER_SOL_U128) as u64;

        if nav_lamports <= v.high_water_mark_lamports {
            return Ok(());
        }
        let uplift = nav_lamports - v.high_water_mark_lamports;
        let fee_lamports = (uplift as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(ErrorCode::SwapMathOverflow)?
            / 10_000u128;
        let fee_lst_units: u64 = (fee_lamports
            .checked_mul(LAMPORTS_PER_SOL_U128)
            .ok_or(ErrorCode::SwapMathOverflow)?
            / current_sol_value_per_lst as u128) as u64;
        if fee_lst_units == 0 {
            return Ok(());
        }

        let owner_key = v.owner;
        let bump = v.bump;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.fee_destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                seeds,
            ),
            fee_lst_units,
        )?;

        let v = &mut ctx.accounts.vault;
        v.high_water_mark_lamports = nav_lamports - (fee_lamports as u64);
        Ok(())
    }
}

#[account]
pub struct Vault {
    pub owner: Pubkey,                 // 32
    pub rotation_authority: Pubkey,    // 32 — Pubkey::default() means revoked
    pub current_lst_mint: Pubkey,      // 32
    pub baseline_amount: u64,          // 8
    pub high_water_mark_lamports: u64, // 8 — NAV high-water in lamports of SOL value
    pub last_rotation_slot: u64,       // 8
    pub perf_fee_bps_max: u16,         // 2
    pub bump: u8,                      // 1
}

impl Vault {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 2 + 1;
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(
        init,
        payer = owner,
        space = Vault::LEN,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositLst<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    pub lst_mint: Account<'info, Mint>,
    #[account(mut, token::mint = lst_mint, token::authority = owner)]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = lst_mint, token::authority = vault)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawLst<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    pub lst_mint: Account<'info, Mint>,
    #[account(mut, token::mint = lst_mint, token::authority = owner)]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = lst_mint, token::authority = vault)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteRotation<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub rotation_authority: Signer<'info>,
    pub source_mint: Account<'info, Mint>,
    pub dest_mint: Account<'info, Mint>,
    #[account(mut, token::mint = source_mint, token::authority = vault)]
    pub vault_source_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = dest_mint, token::authority = vault)]
    pub vault_dest_account: Account<'info, TokenAccount>,
    /// CHECK: pinned to JUPITER_V6_PROGRAM_ID; passed through to invoke_signed.
    #[account(address = JUPITER_V6_PROGRAM_ID)]
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimPerfFee<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub rotation_authority: Signer<'info>,
    pub current_lst_mint: Account<'info, Mint>,
    #[account(mut, token::mint = current_lst_mint, token::authority = vault)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = current_lst_mint)]
    pub fee_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("perf fee bps exceeds vault cap")]
    FeeBpsTooHigh,
    #[msg("token mint does not match vault state")]
    WrongMint,
    #[msg("rotation authority signer does not match vault")]
    NotAuthorized,
    #[msg("rotation authority has been revoked by owner")]
    AuthorityRevoked,
    #[msg("swap math overflowed")]
    SwapMathOverflow,
    #[msg("slippage exceeded — output below min_out_amount")]
    SlippageExceeded,
    #[msg("source token account did not decrease — swap did not execute")]
    SourceUnchanged,
    #[msg("oracle value must be > 0")]
    InvalidOracleValue,
}
