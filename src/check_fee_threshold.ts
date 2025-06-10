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

        // Distribute to token holders
        //await findHoldersWithProportions(mint);
        
        return { success: true, totalFees, accountCount: accountsWithFees.length };

    } catch (err) {
        console.error(`❌ Error harvesting fees for token ${mint}:`, err);
        throw err;
    }
}

// Automatic harvesting scheduler
export async function startAutomaticHarvesting(mint: string, intervalMinutes: number = 60) {
    console.log(`🤖 Starting automatic fee harvesting for token: ${mint}`);
    console.log(`⏰ Checking every ${intervalMinutes} minutes`);
    
    // Run initial fee check
    await checkAvailableFees(mint);
    
    // Run initial harvest
    await harvestTokenFees(mint);
    
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

// Start automatic harvesting (runs every hour by default)
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
}

// Validate before starting
validateConfig();

// Add option to just check fees without harvesting
const CHECK_ONLY = process.env.CHECK_ONLY === 'true';

if (CHECK_ONLY) {
    // Just check fees and exit
    checkFeesOnly(TOKEN_MINT).then(() => {
        console.log(`\n✅ Fee check completed. Set CHECK_ONLY=false to enable harvesting.`);
        process.exit(0);
    });
} else {
    // Start automatic harvesting
    startAutomaticHarvesting(TOKEN_MINT, HARVEST_INTERVAL);
}