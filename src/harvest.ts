import {
    Connection,
    Keypair,
    PublicKey
} from "@solana/web3.js";

import {
    TOKEN_2022_PROGRAM_ID,
    withdrawWithheldTokensFromAccounts
    } from "@solana/spl-token";

    
export async function harvestWithheldTokensToAuthority(connection: Connection, payer: Keypair, mint: PublicKey, destinationTokenAccount: PublicKey, withdrawWithheldAuthority: PublicKey, accountsToWithdrawFrom: PublicKey[]) {
    try {
        // Withdraw withheld tokens from Token Accounts
        const transactionSignature = await withdrawWithheldTokensFromAccounts(
            connection,
            payer, // Transaction fee payer
            mint, // Mint Account address
            destinationTokenAccount, // Destination account for fee withdrawal
            withdrawWithheldAuthority, // Authority for fee withdrawal
            [], // Additional signers
            accountsToWithdrawFrom, // Token Accounts to withdrawal from
            undefined, // Confirmation options
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );
        
        console.log(
            "\nWithdraw Fee From Token Accounts:",
            `https://solana.fm/tx/${transactionSignature}?cluster=devnet-solana`,
        );
    } catch (err) {
        console.error("harvestWithheldTokensToMint::Error:", err);
    }
}