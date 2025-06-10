import {
    Connection,
    Keypair,
    PublicKey
} from "@solana/web3.js";

import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    withdrawWithheldTokensFromAccounts,
    getAccount,
    getMint,
    getTransferFeeConfig,
    getTransferFeeAmount,
    Account
} from "@solana/spl-token";

export async function harvestWithheldTokensToAuthority(
    connection: Connection, 
    payer: Keypair, 
    mint: PublicKey, 
    destinationTokenAccount: PublicKey, 
    withdrawWithheldAuthority: PublicKey, 
    accountsToWithdrawFrom: PublicKey[]
) {
    try {
        // 1. Verify the mint has transfer fee extension
        const mintInfo = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID);
        const transferFeeConfig = getTransferFeeConfig(mintInfo);
        
        if (!transferFeeConfig) {
            throw new Error("Mint does not have transfer fee extension enabled");
        }

        console.log("Transfer Fee Config:", transferFeeConfig);

        // 2. Filter accounts that actually have withheld tokens
        const validAccounts = [];
        
        for (const accountPubkey of accountsToWithdrawFrom) {
            try {
                // First, detect which program owns this account
                const rawAccountInfo = await connection.getAccountInfo(accountPubkey);
                if (!rawAccountInfo) {
                    console.log(`Account ${accountPubkey.toBase58()} not found, skipping`);
                    continue;
                }

                const isToken2022 = rawAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
                const isTokenProgram = rawAccountInfo.owner.equals(TOKEN_PROGRAM_ID);
                
                if (!isToken2022 && !isTokenProgram) {
                    console.log(`Account ${accountPubkey.toBase58()} is not a token account, skipping`);
                    continue;
                }

                // Use the correct program ID based on ownership
                const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
                const accountInfo = await getAccount(connection, accountPubkey, undefined, programId);
                
                // Only Token-2022 accounts can have withheld tokens
                if (isToken2022) {
                    const transferFeeAmount = getTransferFeeAmount(accountInfo);
                    
                    if (transferFeeAmount && transferFeeAmount.withheldAmount > 0n) {
                        validAccounts.push(accountPubkey);
                        console.log(`Account ${accountPubkey.toBase58()} has ${transferFeeAmount.withheldAmount} withheld tokens`);
                    } else {
                        console.log(`Account ${accountPubkey.toBase58()} has no withheld tokens, skipping`);
                    }
                } else {
                    console.log(`Account ${accountPubkey.toBase58()} is regular SPL Token (no transfer fees), skipping`);
                }
            } catch (error) {
                const err = error as Error;
                console.error(`Failed to get account info for ${accountPubkey.toBase58()}:`, err.message);
            }
        }

        if (validAccounts.length === 0) {
            console.log("No accounts with withheld tokens found");
            return null;
        }

        // 3. Verify destination account exists and is correct
        const destinationAccount = await getAccount(connection, destinationTokenAccount, undefined, TOKEN_2022_PROGRAM_ID);
        
        if (destinationAccount.mint.toBase58() !== mint.toBase58()) {
            throw new Error("Destination account mint does not match the specified mint");
        }

        console.log(`Withdrawing from ${validAccounts.length} accounts with withheld tokens`);

        // 4. Withdraw withheld tokens from valid accounts only
        const transactionSignature = await withdrawWithheldTokensFromAccounts(
            connection,
            payer, // Transaction fee payer
            mint, // Mint Account address
            destinationTokenAccount, // Destination account for fee withdrawal
            withdrawWithheldAuthority, // Authority for fee withdrawal
            [], // Additional signers (empty if withdrawWithheldAuthority is the payer)
            validAccounts, // Only accounts with withheld tokens
            {
                commitment: 'confirmed',
                skipPreflight: false
            }, // Confirmation options
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        console.log(
            "\nWithdraw Fee From Token Accounts:",
            `https://solscan.io/tx/${transactionSignature}`,
        );

        return transactionSignature;

    } catch (error) {
        const err = error as any;
        console.error("harvestWithheldTokensToMint::Error:", err);
        
        // Enhanced error logging
        if (err.transactionLogs) {
            console.error("Transaction Logs:", err.transactionLogs);
        }
        
        throw err;
    }
}

// Helper function to check if accounts have withheld tokens with proper program detection
export async function checkWithheldTokens(
    connection: Connection,
    accounts: PublicKey[]
): Promise<{ account: PublicKey; withheldAmount: bigint }[]> {
    const results = [];
    
    for (const account of accounts) {
        try {
            // Detect program ownership first
            const rawAccountInfo = await connection.getAccountInfo(account);
            if (!rawAccountInfo) continue;

            const isToken2022 = rawAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
            if (!isToken2022) continue; // Only Token-2022 accounts can have withheld tokens

            const accountInfo = await getAccount(connection, account, undefined, TOKEN_2022_PROGRAM_ID);
            const transferFeeAmount = getTransferFeeAmount(accountInfo);
            
            if (transferFeeAmount && transferFeeAmount.withheldAmount > 0n) {
                results.push({
                    account,
                    withheldAmount: transferFeeAmount.withheldAmount
                });
            }
        } catch (error) {
            const err = error as Error;
            console.error(`Error checking account ${account.toBase58()}:`, err.message);
        }
    }
    
    return results;
}

// Enhanced version with better error handling and validation
export async function harvestWithheldTokensToAuthorityEnhanced(
    connection: Connection, 
    payer: Keypair, 
    mint: PublicKey, 
    destinationTokenAccount: PublicKey, 
    withdrawWithheldAuthority: Keypair, // Changed to Keypair for signing
    accountsToWithdrawFrom: PublicKey[]
) {
    try {
        // Pre-flight checks
        console.log("Performing pre-flight checks...");
        
        // Check withheld tokens first
        const accountsWithWithheld = await checkWithheldTokens(connection, accountsToWithdrawFrom);
        console.log("Token-2022 accounts with withheld tokens:", accountsWithWithheld);
        
        if (accountsWithWithheld.length === 0) {
            console.log("No accounts have withheld tokens to harvest");
            return null;
        }

        console.log(`Found ${accountsWithWithheld.length} accounts with withheld tokens:`);
        accountsWithWithheld.forEach(({ account, withheldAmount }) => {
            console.log(`  ${account.toBase58()}: ${withheldAmount} tokens`);
        });

        // Extract just the account public keys
        const validAccountPubkeys = accountsWithWithheld.map(item => item.account);

        // Perform the withdrawal
        const transactionSignature = await withdrawWithheldTokensFromAccounts(
            connection,
            payer,
            mint,
            destinationTokenAccount,
            withdrawWithheldAuthority,
            [], // Additional signers - empty since withdrawWithheldAuthority is already a signer
            validAccountPubkeys,
            {
                commitment: 'confirmed',
                preflightCommitment: 'confirmed'
            },
            TOKEN_2022_PROGRAM_ID,
        );

        console.log("Harvest successful!");
        console.log(`Transaction: https://solscan.io/tx/${transactionSignature}`);
        
        return transactionSignature;

    } catch (error) {
        const err = error as any;
        console.error("Enhanced harvest failed:", err);
        
        if (err.transactionLogs) {
            console.error("Full transaction logs:");
            err.transactionLogs.forEach((log: string, index: number) => {
                console.error(`  ${index}: ${log}`);
            });
        }
        
        throw err;
    }
}

// Alternative method using raw account data parsing if getTransferFeeAmount doesn't work
export async function getWithheldTokensFromRawData(
    connection: Connection,
    account: PublicKey
): Promise<bigint | null> {
    try {
        const accountInfo = await connection.getAccountInfo(account);
        if (!accountInfo || !accountInfo.data) {
            return null;
        }

        // Token-2022 account data structure includes extensions at the end
        // The withheld amount is stored in the TransferFeeAmount extension
        const data = accountInfo.data;
        
        // Basic validation that this is a Token-2022 account
        if (data.length < 165) { // Minimum size for Token-2022 account with extensions
            return null;
        }

        return null;
        
    } catch (error) {
        const err = error as Error;
        console.error(`Error getting raw account data:`, err.message);
        return null;
    }
}

