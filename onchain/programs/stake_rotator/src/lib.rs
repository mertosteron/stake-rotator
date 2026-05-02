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
// - `claim_performance_fee` prices the current LST through Sanctum's on-chain
//   SOL Value Calculator interface; the bot cannot supply a price.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::{get_return_data, invoke, invoke_signed},
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5ra9y6YL7dqWWHGvVDQsuj4HND3DeLaea38jHEMvGoaS");

const VAULT_SEED: &[u8] = b"vault";
const SOL_VALUE_CALCULATOR_RETURN_LEN: usize = 16;

// Jupiter v6 aggregator program ID.
pub const JUPITER_V6_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177, 178, 222,
    163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143,
]);

// Sanctum SOL Value Calculator programs.
pub const SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    13, 4, 49, 101, 142, 147, 255, 106, 156, 24, 242, 6, 148, 83, 103, 164, 26, 128, 182, 236,
    186, 17, 81, 7, 50, 208, 50, 240, 166, 30, 111, 150,
]);
pub const SANCTUM_SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    13, 8, 128, 68, 114, 220, 21, 215, 58, 156, 67, 237, 167, 41, 139, 246, 75, 109, 45, 229,
    183, 87, 36, 170, 15, 174, 217, 207, 28, 64, 6, 120,
]);
pub const SANCTUM_SPL_MULTI_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    13, 8, 113, 244, 157, 15, 149, 30, 172, 177, 5, 234, 25, 38, 117, 24, 106, 166, 213, 175,
    70, 248, 124, 125, 30, 79, 206, 139, 50, 235, 5, 114,
]);
pub const MARINADE_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 107, 214, 38, 17, 52, 58, 163, 112, 136, 117, 179, 109, 82, 198, 170, 177, 61, 242, 47,
    115, 250, 17, 187, 124, 82, 172, 198, 86, 45, 197, 202,
]);
pub const LIDO_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0, 47, 17, 228, 71, 112, 231, 24, 163, 45, 146, 53, 174, 166, 116, 136, 53, 249, 208, 90,
    169, 236, 89, 199, 143, 251, 143, 84, 83, 117, 5, 108,
]);
pub const WSOL_SOL_VALUE_CALCULATOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    14, 14, 205, 10, 61, 204, 45, 160, 19, 92, 21, 237, 10, 251, 131, 152, 224, 213, 147, 237,
    142, 198, 190, 169, 193, 75, 202, 207, 46, 96, 146, 173,
]);

fn is_allowed_sol_value_calculator(program_id: Pubkey) -> bool {
    matches!(
        program_id,
        SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID
            | SANCTUM_SPL_SOL_VALUE_CALCULATOR_PROGRAM_ID
            | SANCTUM_SPL_MULTI_SOL_VALUE_CALCULATOR_PROGRAM_ID
            | MARINADE_SOL_VALUE_CALCULATOR_PROGRAM_ID
            | LIDO_SOL_VALUE_CALCULATOR_PROGRAM_ID
            | WSOL_SOL_VALUE_CALCULATOR_PROGRAM_ID
    )
}

fn read_sol_value_calculator_return(calculator_program: Pubkey) -> Result<(u64, u64)> {
    let (program_id, data) = get_return_data().ok_or(ErrorCode::InvalidOracleValue)?;
    require_keys_eq!(program_id, calculator_program, ErrorCode::InvalidOracleValue);
    require!(
        data.len() == SOL_VALUE_CALCULATOR_RETURN_LEN,
        ErrorCode::InvalidOracleValue
    );
    let min = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleValue)?,
    );
    let max = u64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| ErrorCode::InvalidOracleValue)?,
    );
    require!(min <= max, ErrorCode::InvalidOracleValue);
    Ok((min, max))
}

fn invoke_sol_value_calculator<'info>(
    calculator_program: &UncheckedAccount<'info>,
    lst_mint: &Account<'info, Mint>,
    remaining_accounts: &[AccountInfo<'info>],
    discriminant: u8,
    amount: u64,
) -> Result<(u64, u64)> {
    let calculator_key = calculator_program.key();
    require!(
        is_allowed_sol_value_calculator(calculator_key),
        ErrorCode::InvalidOracleProgram
    );

    let mut data = Vec::with_capacity(9);
    data.push(discriminant);
    data.extend_from_slice(&amount.to_le_bytes());

    let mut metas = Vec::with_capacity(1 + remaining_accounts.len());
    metas.push(AccountMeta::new_readonly(lst_mint.key(), false));
    for acc in remaining_accounts.iter() {
        metas.push(if acc.is_writable {
            AccountMeta::new(*acc.key, acc.is_signer)
        } else {
            AccountMeta::new_readonly(*acc.key, acc.is_signer)
        });
    }

    let ix = Instruction {
        program_id: calculator_key,
        accounts: metas,
        data,
    };

    let mut infos = Vec::with_capacity(2 + remaining_accounts.len());
    infos.push(lst_mint.to_account_info());
    infos.extend(remaining_accounts.iter().cloned());
    infos.push(calculator_program.to_account_info());
    invoke(&ix, &infos)?;
    read_sol_value_calculator_return(calculator_key)
}

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
    /// Valuation is performed through Sanctum's on-chain SOL Value Calculator CPI.
    pub fn claim_performance_fee<'info>(
        ctx: Context<'_, '_, '_, 'info, ClaimPerfFee<'info>>,
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

        let lst_balance = ctx.accounts.vault_token_account.amount;
        let (nav_min_lamports, _nav_max_lamports) = invoke_sol_value_calculator(
            &ctx.accounts.sol_value_calculator_program,
            &ctx.accounts.current_lst_mint,
            ctx.remaining_accounts,
            0,
            lst_balance,
        )?;

        if nav_min_lamports <= v.high_water_mark_lamports {
            return Ok(());
        }
        let uplift = nav_min_lamports - v.high_water_mark_lamports;
        let fee_lamports = (uplift as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(ErrorCode::SwapMathOverflow)?
            / 10_000u128;
        let fee_lamports = u64::try_from(fee_lamports).map_err(|_| ErrorCode::SwapMathOverflow)?;
        if fee_lamports == 0 {
            return Ok(());
        }

        let (fee_lst_min, _fee_lst_max) = invoke_sol_value_calculator(
            &ctx.accounts.sol_value_calculator_program,
            &ctx.accounts.current_lst_mint,
            ctx.remaining_accounts,
            1,
            fee_lamports,
        )?;
        if fee_lst_min == 0 {
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
            fee_lst_min,
        )?;

        let v = &mut ctx.accounts.vault;
        v.high_water_mark_lamports = nav_min_lamports.saturating_sub(fee_lamports);
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
    /// CHECK: must be one of Sanctum's pinned SOL Value Calculator programs.
    pub sol_value_calculator_program: UncheckedAccount<'info>,
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
    #[msg("oracle value returned by SOL value calculator is invalid")]
    InvalidOracleValue,
    #[msg("oracle program is not an allowed Sanctum SOL value calculator")]
    InvalidOracleProgram,
}
