import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction
} from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    getAccount,
    transfer,
    createTransferInstruction
} from "@solana/spl-token";

// Jupiter API types
interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageType: string;
    platformFee: any;
    priceImpactPct: string;
    routePlan: any[];
}

interface JupiterSwapResponse {
    swapTransaction: string;
}

/**
 * Swap harvested tokens to SOL using Jupiter API
 */
export async function swapTokensToSol(
    connection: Connection,
    payer: Keypair,
    tokenMint: string,
    amount: number,
    slippageBps: number = 300 // 3% slippage
): Promise<{ success: boolean; solReceived?: number; signature?: string; error?: string }> {
    try {
        console.log(`🔄 Starting swap: ${amount} tokens to SOL`);
        
        // 1. Get quote from Jupiter
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?` +
            `inputMint=${tokenMint}&` +
            `outputMint=So11111111111111111111111111111111111111112&` + // SOL mint
            `amount=${amount}&` +
            `slippageBps=${slippageBps}`;
        
        console.log("📊 Getting quote from Jupiter...");
        const quoteResponse = await fetch(quoteUrl);
        
        if (!quoteResponse.ok) {
            throw new Error(`Quote API error: ${quoteResponse.status}`);
        }
        
        const quoteData: JupiterQuoteResponse = await quoteResponse.json();
        const expectedSol = parseInt(quoteData.outAmount) / LAMPORTS_PER_SOL;
        
        console.log(`💰 Expected SOL output: ${expectedSol.toFixed(6)} SOL`);
        console.log(`💸 Price impact: ${quoteData.priceImpactPct}%`);
        
        // 2. Get swap transaction
        console.log("🔨 Building swap transaction...");
        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: payer.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 1000000, // Priority fee
            })
        });
        
        if (!swapResponse.ok) {
            throw new Error(`Swap API error: ${swapResponse.status}`);
        }
        
        const swapData: JupiterSwapResponse = await swapResponse.json();
        
        // 3. Deserialize and sign transaction
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = Transaction.from(swapTransactionBuf);
        
        // 4. Sign and send transaction
        transaction.sign(payer);
        
        console.log("📡 Sending swap transaction...");
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        
        // 5. Confirm transaction
        await connection.confirmTransaction(signature, 'confirmed');
        
        console.log(`✅ Swap successful!`);
        console.log(`📋 Transaction: https://solscan.io/tx/${signature}`);
        console.log(`💰 Received: ~${expectedSol.toFixed(6)} SOL`);
        
        return {
            success: true,
            solReceived: expectedSol,
            signature
        };
        
    } catch (error) {
        console.error("❌ Swap failed:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Distribute SOL to multiple wallets with specified percentages
 */
export async function distributeSol(
    connection: Connection,
    payer: Keypair,
    totalSolAmount: number,
    recipients: Array<{ address: string; percentage: number }>
): Promise<{ success: boolean; distributions?: Array<{ address: string; amount: number; signature: string }>; error?: string }> {
    try {
        console.log(`💸 Starting SOL distribution: ${totalSolAmount} SOL`);
        
        // Validate percentages
        const totalPercentage = recipients.reduce((sum, r) => sum + r.percentage, 0);
        if (Math.abs(totalPercentage - 100) > 0.01) {
            console.warn(`⚠️ Warning: Total percentage is ${totalPercentage}%, not 100%`);
        }
        
        const distributions = [];
        
        for (const recipient of recipients) {
            const amount = (totalSolAmount * recipient.percentage) / 100;
            const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
            
            if (lamports < 1) {
                console.log(`⏭️ Skipping ${recipient.address} - amount too small: ${amount} SOL`);
                continue;
            }
            
            console.log(`💰 Sending ${amount.toFixed(6)} SOL (${recipient.percentage}%) to ${recipient.address}`);
            
            try {
                const recipientPubkey = new PublicKey(recipient.address);
                
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: payer.publicKey,
                        toPubkey: recipientPubkey,
                        lamports: lamports,
                    })
                );
                
                const signature = await sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [payer],
                    { commitment: 'confirmed' }
                );
                
                distributions.push({
                    address: recipient.address,
                    amount: amount,
                    signature
                });
                
                console.log(`✅ Sent ${amount.toFixed(6)} SOL to ${recipient.address}`);
                console.log(`📋 Transaction: https://solscan.io/tx/${signature}`);
                
            } catch (error) {
                console.error(`❌ Failed to send to ${recipient.address}:`, error);
                // Continue with other recipients
            }
        }
        
        console.log(`✅ Distribution completed: ${distributions.length}/${recipients.length} successful`);
        
        return {
            success: distributions.length > 0,
            distributions
        };
        
    } catch (error) {
        console.error("❌ Distribution failed:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Distribute tokens (alternative to SOL distribution)
 */
export async function distributeTokens(
    connection: Connection,
    payer: Keypair,
    tokenMint: string,
    totalTokenAmount: number,
    recipients: Array<{ address: string; percentage: number }>
): Promise<{ success: boolean; distributions?: Array<{ address: string; amount: number; signature: string }>; error?: string }> {
    try {
        console.log(`🪙 Starting token distribution: ${totalTokenAmount} tokens`);
        
        // Detect token program
        const mintPubkey = new PublicKey(tokenMint);
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (!mintInfo) {
            throw new Error("Token mint not found");
        }
        
        const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
        const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        
        console.log(`Using ${isToken2022 ? 'Token-2022' : 'SPL Token'} program`);
        
        // Get source token account
        const sourceTokenAccount = await getAssociatedTokenAddress(
            mintPubkey,
            payer.publicKey,
            false,
            programId
        );
        
        const distributions = [];
        
        for (const recipient of recipients) {
            const amount = Math.floor((totalTokenAmount * recipient.percentage) / 100);
            
            if (amount < 1) {
                console.log(`⏭️ Skipping ${recipient.address} - amount too small: ${amount} tokens`);
                continue;
            }
            
            console.log(`🪙 Sending ${amount} tokens (${recipient.percentage}%) to ${recipient.address}`);
            
            try {
                const recipientPubkey = new PublicKey(recipient.address);
                
                // Get or create recipient's token account
                const recipientTokenAccount = await getAssociatedTokenAddress(
                    mintPubkey,
                    recipientPubkey,
                    false,
                    programId
                );
                
                const transaction = new Transaction();
                
                // Check if recipient token account exists
                try {
                    await getAccount(connection, recipientTokenAccount, undefined, programId);
                } catch (error) {
                    // Account doesn't exist, create it
                    console.log(`Creating token account for ${recipient.address}`);
                    transaction.add(
                        createAssociatedTokenAccountInstruction(
                            payer.publicKey,
                            recipientTokenAccount,
                            recipientPubkey,
                            mintPubkey,
                            programId
                        )
                    );
                }
                
                // Add transfer instruction
                transaction.add(
                    createTransferInstruction(
                        sourceTokenAccount,
                        recipientTokenAccount,
                        payer.publicKey,
                        amount,
                        [],
                        programId
                    )
                );
                
                const signature = await sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [payer],
                    { commitment: 'confirmed' }
                );
                
                distributions.push({
                    address: recipient.address,
                    amount: amount,
                    signature
                });
                
                console.log(`✅ Sent ${amount} tokens to ${recipient.address}`);
                console.log(`📋 Transaction: https://solscan.io/tx/${signature}`);
                
            } catch (error) {
                console.error(`❌ Failed to send to ${recipient.address}:`, error);
                // Continue with other recipients
            }
        }
        
        console.log(`✅ Token distribution completed: ${distributions.length}/${recipients.length} successful`);
        
        return {
            success: distributions.length > 0,
            distributions
        };
        
    } catch (error) {
        console.error("❌ Token distribution failed:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Complete workflow: Swap tokens and distribute SOL
 */
export async function swapAndDistribute(
    connection: Connection,
    payer: Keypair,
    tokenMint: string,
    tokenAmount: number,
    recipients: Array<{ address: string; percentage: number }>,
    slippageBps: number = 300
): Promise<{ success: boolean; swapResult?: any; distributionResult?: any; error?: string }> {
    try {
        console.log(`🔄 Starting swap and distribution workflow`);
        console.log(`🪙 Token amount: ${tokenAmount}`);
        console.log(`👥 Recipients: ${recipients.length}`);
        
        // Step 1: Swap tokens to SOL
        const swapResult = await swapTokensToSol(connection, payer, tokenMint, tokenAmount, slippageBps);
        
        if (!swapResult.success) {
            throw new Error(`Swap failed: ${swapResult.error}`);
        }
        
        // Step 2: Distribute SOL
        const distributionResult = await distributeSol(
            connection,
            payer,
            swapResult.solReceived || 0,
            recipients
        );
        
        if (!distributionResult.success) {
            throw new Error(`Distribution failed: ${distributionResult.error}`);
        }
        
        console.log(`✅ Swap and distribution completed successfully!`);
        
        return {
            success: true,
            swapResult,
            distributionResult
        };
        
    } catch (error) {
        console.error("❌ Swap and distribution workflow failed:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Test configuration for 0.002 SOL distribution
export const TEST_DISTRIBUTION_CONFIG = {
    totalSolAmount: 0.002,
    recipients: [
        {
            address: "61gHnTREoVAiBo1S7FacueC4ceTtpkXVLuaLDJUpYVzr", 
            percentage: 2.5
        },
        {
            address: "3PFtymX5VTKh8T4mZCY5wh436U4PKPyrEaRx83esccwE", 
            percentage: 2.5
        }
    ]
};

/**
 * Test function for SOL distribution only
 */
export async function testSolDistribution(
    connection: Connection,
    payer: Keypair
): Promise<void> {
    console.log("🧪 Testing SOL distribution...");
    
    const result = await distributeSol(
        connection,
        payer,
        TEST_DISTRIBUTION_CONFIG.totalSolAmount,
        TEST_DISTRIBUTION_CONFIG.recipients
    );
    
    if (result.success) {
        console.log("✅ Test distribution successful!");
        result.distributions?.forEach(dist => {
            console.log(`   ${dist.address}: ${dist.amount} SOL`);
        });
    } else {
        console.error("❌ Test distribution failed:", result.error);
    }
}