import {
    Connection,
    Keypair,
    PublicKey,
    clusterApiUrl
} from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getTransferFeeAmount,
    unpackAccount,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    getAccount
} from "@solana/spl-token";
import { harvestWithheldTokensToAuthority } from "./harvest";
import { swapAndDistribute, distributeSol, TEST_DISTRIBUTION_CONFIG } from "./swap";
import * as fs from "fs";
import 'dotenv/config';

const API_KEY = process.env.API_KEY;

// Initialize connection and payer once
const connection = new Connection(`https://rpc.helius.xyz/?api-key=${API_KEY}`, "confirmed");

// Load wallet with proper error handling
function loadWallet(): Keypair {
    const walletPath = process.env.WALLET_PATH || "wallet.json";
    
    try {
        if (!fs.existsSync(walletPath)) {
            throw new Error(`Wallet file not found at: ${walletPath}`);
        }
        
        const walletData = fs.readFileSync(walletPath, "utf-8");
        
        if (!walletData.trim()) {
            throw new Error(`Wallet file is empty: ${walletPath}`);
        }
        
        const secretKey = JSON.parse(walletData);
        
        if (!Array.isArray(secretKey) || secretKey.length !== 64) {
            throw new Error(`Invalid wallet format. Expected array of 64 numbers, got: ${typeof secretKey}`);
        }
        
        return Keypair.fromSecretKey(new Uint8Array(secretKey));
        
    } catch (error) {
        console.error("❌ Failed to load wallet:");
        console.error(`   Path: ${walletPath}`);
        
        if (error instanceof SyntaxError) {
            console.error("   Error: Invalid JSON format in wallet file");
            console.error("   Solution: Make sure wallet.json contains a valid array of 64 numbers");
        } else if (error instanceof Error) {
            console.error(`   Error: ${error.message}`);
        } else {
            console.error(`   Error: ${String(error)}`);
        }
        
        console.error("\n💡 To fix this:");
        console.error("   1. Make sure wallet.json exists in your project root");
        console.error("   2. It should contain your secret key as JSON array: [1,2,3,4,...]");
        console.error("   3. Or set WALLET_PATH environment variable to point to your wallet file");
        
        process.exit(1);
    }
}

const payer = loadWallet();
const threshHold = Number(process.env.THRESH_HOLD) || 0;

// Helper function to detect token program and get associated token address
async function getOrCreateAssociatedTokenAccount(
    connection: Connection,
    payer: Keypair,
    mint: PublicKey,
    owner: PublicKey
): Promise<PublicKey> {
    // First, detect which program owns the mint
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
        throw new Error("Mint account not found");
    }

    const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    console.log(`Mint is ${isToken2022 ? 'Token-2022' : 'SPL Token'} program`);

    // Get the associated token address
    const associatedTokenAddress = await getAssociatedTokenAddress(
        mint,
        owner,
        false, // allowOwnerOffCurve
        programId
    );

    console.log(`Associated token address: ${associatedTokenAddress.toBase58()}`);

    // Check if the account already exists
    try {
        await getAccount(connection, associatedTokenAddress, undefined, programId);
        console.log("Associated token account already exists");
        return associatedTokenAddress;
    } catch (error) {
        console.log("Associated token account doesn't exist, will be created during harvest");
        return associatedTokenAddress;
    }
}

export async function checkAvailableFees(mint: string) {
    try {
        const mintPubkey = new PublicKey(mint);
        
        console.log(`🔍 Checking available fees for token: ${mint}`);
        
        // First detect which program owns this mint
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (!mintInfo) {
            throw new Error("Mint account not found");
        }

        const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
        const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        
        console.log(`Token uses ${isToken2022 ? 'Token-2022' : 'SPL Token'} program`);

        if (!isToken2022) {
            console.log("⚠️  This is a regular SPL Token - no transfer fees available");
            return {
                totalAccounts: 0,
                totalBalance: 0,
                totalWithheldFees: 0,
                harvestableAccounts: 0,
                harvestableFees: 0,
                threshold: threshHold,
                accounts: []
            };
        }
        
        // Get all token accounts for this specific token
        const tokenAccounts = await connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{
                memcmp: {
                    offset: 0,
                    bytes: mint,
                },
            }],
        });

        console.log(`📊 Found ${tokenAccounts.length} total token accounts`);

        // Analyze all accounts for fee data
        const feeAnalysis = tokenAccounts.map(accountInfo => {
            const account = unpackAccount(
                accountInfo.pubkey,
                accountInfo.account,
                programId
            );
            
            const feeAmount = getTransferFeeAmount(account);
            const withheldAmount = feeAmount?.withheldAmount || BigInt(0);
            const withheldNumber = Number(withheldAmount);
            
            return {
                accountAddress: accountInfo.pubkey.toString(),
                withheldAmount: withheldNumber,
                isHarvestable: feeAmount !== null && withheldNumber > threshHold,
                balance: Number(account.amount)
            };
        });

        // Calculate totals
        const totalWithheldFees = feeAnalysis.reduce((sum, acc) => sum + acc.withheldAmount, 0);
        const harvestableAccounts = feeAnalysis.filter(acc => acc.isHarvestable);
        const harvestableFees = harvestableAccounts.reduce((sum, acc) => sum + acc.withheldAmount, 0);
        const totalBalance = feeAnalysis.reduce((sum, acc) => sum + acc.balance, 0);

        // Display results
        console.log(`\n📈 Fee Analysis Results:`);
        console.log(`   Total Token Accounts: ${tokenAccounts.length}`);
        console.log(`   Total Token Balance: ${totalBalance.toLocaleString()}`);
        console.log(`   Total Withheld Fees: ${totalWithheldFees.toLocaleString()}`);
        console.log(`   Harvestable Accounts: ${harvestableAccounts.length}`);
        console.log(`   Harvestable Fees: ${harvestableFees.toLocaleString()}`);
        console.log(`   Fee Threshold: ${threshHold.toLocaleString()}`);

        if (harvestableAccounts.length > 0) {
            console.log(`\n💰 Top accounts with harvestable fees:`);
            harvestableAccounts
                .sort((a, b) => b.withheldAmount - a.withheldAmount)
                .slice(0, 5)
                .forEach((acc, index) => {
                    console.log(`   ${index + 1}. ${acc.accountAddress.slice(0, 8)}... - ${acc.withheldAmount.toLocaleString()} fees`);
                });
        }

        return {
            totalAccounts: tokenAccounts.length,
            totalBalance,
            totalWithheldFees,
            harvestableAccounts: harvestableAccounts.length,
            harvestableFees,
            threshold: threshHold,
            accounts: feeAnalysis
        };

    } catch (err) {
        console.error(`❌ Error checking fees for token ${mint}:`, err);
        throw err;
    }
}

export async function harvestTokenFees(mint: string) {
    try {
        const mintPubkey = new PublicKey(mint);
        
        // First detect which program owns this mint
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (!mintInfo) {
            throw new Error("Mint account not found");
        }

        const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
        
        if (!isToken2022) {
            console.log("⚠️  This is a regular SPL Token - no transfer fees to harvest");
            return { success: false, message: "No transfer fees available for SPL Token" };
        }

        const programId = TOKEN_2022_PROGRAM_ID;
        
        // Getting/creating the destination token account for the payer
        const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mintPubkey,
            payer.publicKey
        );

        console.log(`Destination token account: ${destinationTokenAccount.toBase58()}`);
        
        // Getting all token accounts for this specific token
        const tokenAccounts = await connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{
                memcmp: {
                    offset: 0,
                    bytes: mint,
                },
            }],
        });

        // Finding accounts with harvestable fees
        const accountsWithFees = tokenAccounts
            .map(accountInfo => {
                const account = unpackAccount(
                    accountInfo.pubkey,
                    accountInfo.account,
                    programId
                );
                
                const feeAmount = getTransferFeeAmount(account);
                const withheldAmount = feeAmount?.withheldAmount || BigInt(0);
                
                return {
                    pubkey: accountInfo.pubkey,
                    withheldAmount: Number(withheldAmount), // Convert to number for consistency
                    hasHarvestableFees: feeAmount !== null && Number(withheldAmount) > threshHold
                };
            })
            .filter(account => account.hasHarvestableFees);

        if (accountsWithFees.length === 0) {
            console.log(`No harvestable fees found for token: ${mint}`);
            return { success: false, message: "No fees to harvest" };
        }

        const totalFees = accountsWithFees.reduce((sum, acc) => sum + acc.withheldAmount, 0);
        console.log(`Harvesting fees from ${accountsWithFees.length} accounts. Total: ${totalFees}`);

        // Harvest all fees in batch
        await harvestWithheldTokensToAuthority(
            connection,
            payer,
            mintPubkey,
            destinationTokenAccount, // Use the proper token account, not wallet address
            payer.publicKey,        // Withdraw authority
            accountsWithFees.map(acc => acc.pubkey)
        );

        console.log(`✅ Successfully harvested ${totalFees} fees for token: ${mint}`);
        
        return { success: true, totalFees, accountCount: accountsWithFees.length };

    } catch (err) {
        console.error(`❌ Error harvesting fees for token ${mint}:`, err);
        throw err;
    }
}

// Updated function to handle swap and distribution after harvesting
export async function harvestSwapAndDistribute(mint: string) {
    try {
        const mintPubkey = new PublicKey(mint);
        
        // First detect which program owns this mint
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (!mintInfo) {
            throw new Error("Mint account not found");
        }

        const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
        
        if (!isToken2022) {
            console.log("⚠️  This is a regular SPL Token - no transfer fees to harvest");
            return { success: false, message: "No transfer fees available for SPL Token" };
        }

        const programId = TOKEN_2022_PROGRAM_ID;
        
        // Getting/creating the destination token account for the payer
        const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mintPubkey,
            payer.publicKey
        );

        console.log(`Destination token account: ${destinationTokenAccount.toBase58()}`);
        
        // Getting all token accounts for this specific token
        const tokenAccounts = await connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{
                memcmp: {
                    offset: 0,
                    bytes: mint,
                },
            }],
        });

        // Finding accounts with harvestable fees
        const accountsWithFees = tokenAccounts
            .map(accountInfo => {
                const account = unpackAccount(
                    accountInfo.pubkey,
                    accountInfo.account,
                    programId
                );
                
                const feeAmount = getTransferFeeAmount(account);
                const withheldAmount = feeAmount?.withheldAmount || BigInt(0);
                
                return {
                    pubkey: accountInfo.pubkey,
                    withheldAmount: Number(withheldAmount),
                    hasHarvestableFees: feeAmount !== null && Number(withheldAmount) > threshHold
                };
            })
            .filter(account => account.hasHarvestableFees);

        if (accountsWithFees.length === 0) {
            console.log(`No harvestable fees found for token: ${mint}`);
            
            // For testing purposes, distribute 0.002 SOL even if no fees were harvested
            if (process.env.ENABLE_TEST_DISTRIBUTION === 'true') {
                console.log("🧪 Running test distribution of 0.002 SOL...");
                
                // Get wallet addresses from environment variables
                const recipients = [
                    {
                        address: process.env.TEST_WALLET_1 || "WALLET_ADDRESS_1_HERE",
                        percentage: 2.5
                    },
                    {
                        address: process.env.TEST_WALLET_2 || "WALLET_ADDRESS_2_HERE",
                        percentage: 2.5
                    }
                ];
                
                const distributionResult = await distributeSol(
                    connection,
                    payer,
                    0.002, // Test amount
                    recipients
                );
                
                if (distributionResult.success) {
                    console.log("✅ Test distribution completed successfully!");
                    return { 
                        success: true, 
                        message: "Test distribution completed",
                        distributionResult 
                    };
                } else {
                    console.error("❌ Test distribution failed:", distributionResult.error);
                    return { 
                        success: false, 
                        message: "Test distribution failed",
                        error: distributionResult.error 
                    };
                }
            }
            
            return { success: false, message: "No fees to harvest" };
        }

        const totalFees = accountsWithFees.reduce((sum, acc) => sum + acc.withheldAmount, 0);
        console.log(`Harvesting fees from ${accountsWithFees.length} accounts. Total: ${totalFees}`);

        // Step 1: Harvest all fees in batch
        await harvestWithheldTokensToAuthority(
            connection,
            payer,
            mintPubkey,
            destinationTokenAccount, // Use the proper token account, not wallet address
            payer.publicKey,        // Withdraw authority
            accountsWithFees.map(acc => acc.pubkey)
        );

        console.log(`✅ Successfully harvested ${totalFees} fees for token: ${mint}`);

        // Step 2: Swap harvested tokens to SOL and distribute
        if (totalFees > 0) {
            console.log(`🔄 Starting swap and distribution process...`);
            
            // Get recipient wallet addresses from environment variables
            const recipients = [
                {
                    address: process.env.RECIPIENT_WALLET_1 || "WALLET_ADDRESS_1_HERE",
                    percentage: 2.5
                },
                {
                    address: process.env.RECIPIENT_WALLET_2 || "WALLET_ADDRESS_2_HERE",
                    percentage: 2.5
                }
            ];
            
            // Validate recipient addresses
            for (const recipient of recipients) {
                if (recipient.address === "WALLET_ADDRESS_1_HERE" || recipient.address === "WALLET_ADDRESS_2_HERE") {
                    console.warn(`⚠️ Warning: Please set RECIPIENT_WALLET_1 and RECIPIENT_WALLET_2 in your .env file`);
                    break;
                }
            }
            
            const swapAndDistributeResult = await swapAndDistribute(
                connection,
                payer,
                mint,
                totalFees,
                recipients,
                300 // 3% slippage
            );
            
            if (swapAndDistributeResult.success) {
                console.log(`✅ Swap and distribution completed successfully!`);
                console.log(`💰 Swapped ${totalFees} tokens`);
                console.log(`📤 Distributed to ${recipients.length} recipients`);
                
                return { 
                    success: true, 
                    totalFees, 
                    accountCount: accountsWithFees.length,
                    swapAndDistributeResult
                };
            } else {
                console.error(`❌ Swap and distribution failed: ${swapAndDistributeResult.error}`);
                return { 
                    success: false, 
                    message: "Harvest successful but swap/distribution failed",
                    error: swapAndDistributeResult.error,
                    totalFees,
                    accountCount: accountsWithFees.length
                };
            }
        }
        
        return { success: true, totalFees, accountCount: accountsWithFees.length };

    } catch (err) {
        console.error(`❌ Error in harvest, swap and distribute for token ${mint}:`, err);
        throw err;
    }
}

// Test function for distribution only (without harvesting)
export async function testDistributionOnly() {
    try {
        console.log("🧪 Testing SOL distribution without harvesting...");
        
        const recipients = [
            {
                address: process.env.TEST_WALLET_1 || "WALLET_ADDRESS_1_HERE",
                percentage: 2.5
            },
            {
                address: process.env.TEST_WALLET_2 || "WALLET_ADDRESS_2_HERE",
                percentage: 2.5
            }
        ];
        
        // Validate recipient addresses
        for (const recipient of recipients) {
            if (recipient.address === "WALLET_ADDRESS_1_HERE" || recipient.address === "WALLET_ADDRESS_2_HERE") {
                console.error("❌ Please set TEST_WALLET_1 and TEST_WALLET_2 in your .env file");
                console.error("   Add these lines to your .env file:");
                console.error("   TEST_WALLET_1=your-first-wallet-address");
                console.error("   TEST_WALLET_2=your-second-wallet-address");
                return { success: false, message: "Recipient addresses not configured" };
            }
        }
        
        const distributionResult = await distributeSol(
            connection,
            payer,
            0.002, // Test amount: 0.002 SOL
            recipients
        );
        
        if (distributionResult.success) {
            console.log("✅ Test distribution completed successfully!");
            return { 
                success: true, 
                message: "Test distribution completed",
                distributionResult 
            };
        } else {
            console.error("❌ Test distribution failed:", distributionResult.error);
            return { 
                success: false, 
                message: "Test distribution failed",
                error: distributionResult.error 
            };
        }
        
    } catch (error) {
        console.error("❌ Test distribution error:", error);
        return { 
            success: false, 
            message: "Test distribution error",
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Automatic harvesting scheduler with swap and distribution
export async function startAutomaticHarvestingWithSwap(mint: string, intervalMinutes: number = 60) {
    console.log(`🤖 Starting automatic fee harvesting with swap and distribution for token: ${mint}`);
    console.log(`⏰ Checking every ${intervalMinutes} minutes`);
    
    // Run initial fee check
    await checkAvailableFees(mint);
    
    // Run initial harvest, swap and distribute
    const result = await harvestSwapAndDistribute(mint);
    
    // Then run on interval
    setInterval(async () => {
        console.log(`🔄 Running scheduled fee harvest, swap and distribution...`);
        try {
            await checkAvailableFees(mint);
            await harvestSwapAndDistribute(mint);
        } catch (error) {
            console.error("❌ Scheduled harvest, swap and distribution failed:", error);
        }
    }, intervalMinutes * 60 * 1000); // Convert minutes to milliseconds
}

// Standalone function to just check fees without harvesting
export async function checkFeesOnly(mint: string) {
    console.log(`🔍 Fee Check Mode - No harvesting will be performed`);
    return await checkAvailableFees(mint);
}

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down automatic harvesting...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down automatic harvesting...');
    process.exit(0);
});

// Configuration
const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS || "";
const HARVEST_INTERVAL = Number(process.env.HARVEST_INTERVAL_MINUTES) || 60;

// Validate configuration before starting
function validateConfig() {
    if (!TOKEN_MINT || TOKEN_MINT.trim() === "") {
        console.error("❌ TOKEN_MINT_ADDRESS is required!");
        console.error("\n💡 To fix this:");
        console.error("   1. Create a .env file in your project root");
        console.error("   2. Add: TOKEN_MINT_ADDRESS=your-actual-token-mint-address");
        console.error("   3. Example: TOKEN_MINT_ADDRESS=3v3Gw3BhgPKJSavbiTpB4KpfDmTz1VfmWW3NjNstDP8h");
        console.error("\n📝 Your .env file should contain:");
        console.error("TOKEN_MINT_ADDRESS=your-token-mint-address-here");
        console.error("HARVEST_INTERVAL_MINUTES=60");
        console.error("THRESH_HOLD=1000000");
        console.error("RECIPIENT_WALLET_1=wallet-address-1");
        console.error("RECIPIENT_WALLET_2=wallet-address-2");
        console.error("# Optional test settings:");
        console.error("ENABLE_TEST_DISTRIBUTION=true");
        console.error("TEST_WALLET_1=test-wallet-address-1");
        console.error("TEST_WALLET_2=test-wallet-address-2");
        process.exit(1);
    }
    
    // Validate it's a valid public key format
    try {
        new PublicKey(TOKEN_MINT);
    } catch (error) {
        console.error(`❌ Invalid TOKEN_MINT_ADDRESS: ${TOKEN_MINT}`);
        console.error("   Make sure it's a valid Solana public key (base58 encoded)");
        console.error("   Example: 3v3Gw3BhgPKJSavbiTpB4KpfDmTz1VfmWW3NjNstDP8h");
        process.exit(1);
    }
    
    console.log(`✅ Configuration validated:`);
    console.log(`   Token: ${TOKEN_MINT}`);
    console.log(`   Interval: ${HARVEST_INTERVAL} minutes`);
    console.log(`   Threshold: ${threshHold}`);
    
    // Check if recipient wallets are configured
    const wallet1 = process.env.RECIPIENT_WALLET_1;
    const wallet2 = process.env.RECIPIENT_WALLET_2;
    
    if (!wallet1 || !wallet2) {
        console.warn("⚠️ Warning: RECIPIENT_WALLET_1 and RECIPIENT_WALLET_2 not set in .env");
        console.warn("   Swap and distribution will use placeholder addresses");
    } else {
        console.log(`   Recipients: ${wallet1.slice(0, 8)}..., ${wallet2.slice(0, 8)}...`);
    }
}

// Validate before starting
validateConfig();

// Execution modes
const CHECK_ONLY = process.env.CHECK_ONLY === 'true';
const TEST_DISTRIBUTION_ONLY = process.env.TEST_DISTRIBUTION_ONLY === 'true';
const ENABLE_SWAP_AND_DISTRIBUTE = process.env.ENABLE_SWAP_AND_DISTRIBUTE !== 'false'; // Enabled by default

if (TEST_DISTRIBUTION_ONLY) {
    // Just test distribution and exit
    testDistributionOnly().then((result) => {
        if (result.success) {
            console.log(`\n✅ Test distribution completed successfully.`);
        } else {
            console.log(`\n❌ Test distribution failed: ${result.message}`);
        }
        process.exit(0);
    });
} else if (CHECK_ONLY) {
    // Just check fees and exit
    checkFeesOnly(TOKEN_MINT).then(() => {
        console.log(`\n✅ Fee check completed. Set CHECK_ONLY=false to enable harvesting.`);
        process.exit(0);
    });
} else if (ENABLE_SWAP_AND_DISTRIBUTE) {
    // Start automatic harvesting with swap and distribution
    console.log("🚀 Starting automatic harvesting with swap and distribution...");
    startAutomaticHarvestingWithSwap(TOKEN_MINT, HARVEST_INTERVAL);
} else {
    // Start original automatic harvesting (without swap/distribution)
    console.log("🚀 Starting automatic harvesting (legacy mode)...");
    startAutomaticHarvesting(TOKEN_MINT, HARVEST_INTERVAL);
}

// Legacy function kept for backwards compatibility
async function startAutomaticHarvesting(mint: string, intervalMinutes: number = 60) {
    console.log(`🤖 Starting automatic fee harvesting for token: ${mint}`);
    console.log(`⏰ Checking every ${intervalMinutes} minutes`);
    
    // Run initial fee check
    await checkAvailableFees(mint);
    
    // Run initial harvest
    const result = await harvestTokenFees(mint);
    
    // Then run on interval
    setInterval(async () => {
        console.log(`🔄 Running scheduled fee harvest check...`);
        try {
            await checkAvailableFees(mint);
            await harvestTokenFees(mint);
        } catch (error) {
            console.error("❌ Scheduled harvest failed:", error);
        }
    }, intervalMinutes * 60 * 1000); // Convert minutes to milliseconds
}