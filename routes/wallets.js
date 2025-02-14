const {
  Connection,
  clusterApiUrl,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createSyncNativeInstruction,
} = require("@solana/spl-token");
const express = require("express");
const db = require("../db/connection.js");
const { Raydium } = require("@raydium-io/raydium-sdk-v2");

const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

const router = express.Router();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wrapSol(wallet, amountToWrap) {
  // Retrieve associated token account for wSOL from the database
  const walletData = await db
    .collection("wallets")
    .findOne({ publicKey: wallet.publicKey.toBase58() });

  if (!walletData || !walletData.tokenAccounts) {
    throw new Error("Wallet or token accounts not found in the database.");
  }

  const wSolTokenAccount = walletData.tokenAccounts.find(
    (account) => account.tokenMintAddress === wSOL_MINT_ADDRESS
  );

  if (!wSolTokenAccount) {
    throw new Error(
      "Associated token account for wSOL not found in the database."
    );
  }

  const associatedTokenAccount = new PublicKey(wSolTokenAccount.tokenAccount);

  console.log(
    "Fetched associated token account for wSOL from database:",
    associatedTokenAccount.toBase58()
  );

  // Create the transaction to wrap SOL into wSOL
  const wrapTransaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: associatedTokenAccount,
      lamports: amountToWrap,
    }),
    createSyncNativeInstruction(associatedTokenAccount)
  );

  await sendAndConfirmTransaction(connection, wrapTransaction, [wallet]);

  console.log(`${amountToWrap} - SOL wrapped into wSOL`);
  return associatedTokenAccount;
}

async function createWallet(sub, tokenMintAddress, connection, db) {
  if (!sub) {
    throw new Error("Missing user sub parameter.");
  }

  const wallet = Keypair.generate();
  const publicKey = wallet.publicKey.toBase58();
  const secretKey = wallet.secretKey.toString();

  console.log("Generated wallet:", publicKey);

  const tokenAccount = await getAssociatedTokenAddress(
    tokenMintAddress, // Mint
    wallet.publicKey // Owner
  );

  console.log("Token account address:", tokenAccount.toBase58());

  // Check if the token account already exists
  const accountInfo = await connection.getAccountInfo(tokenAccount);
  if (!accountInfo) {
    const masterWallet = await db
      .collection("wallets")
      .findOne({ master: true });
    if (!masterWallet) {
      throw new Error("Master wallet not found in the database.");
    }

    const secretKeyArray = masterWallet.secretKey.split(",").map(Number);
    const feePayer = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

    console.log(
      "Using master wallet as fee payer:",
      feePayer.publicKey.toBase58()
    );

    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        feePayer.publicKey, // Payer
        tokenAccount, // ATA
        wallet.publicKey, // Owner
        tokenMintAddress // Mint
      )
    );

    await sendAndConfirmTransaction(connection, transaction, [feePayer]);
  }

  // Initialize the tokenAccounts array with the SOL token account
  const tokenAccounts = [
    {
      tokenAccount: tokenAccount.toBase58(),
      tokenMintAddress: tokenMintAddress.toBase58(),
    },
  ];

  // Include the sub parameter in the returned object
  return {
    sub, // Associate the wallet with the user
    publicKey,
    secretKey,
    tokenAccounts, // Store all token accounts in this array
    createdAt: new Date(),
  };
}

// ------------------------------------
// 1. Generate Wallet Endpoint
// ------------------------------------
router.post("/create", async (req, res) => {
  try {
    const { sub, tokenMintAddress } = req.body;

    if (!sub) {
      return res.status(400).json({ error: "Missing user sub parameter." });
    }

    // Default to the SOL mint address if none is provided
    const mintAddress = new PublicKey(tokenMintAddress || wSOL_MINT_ADDRESS);

    // Create the wallet and initial token account
    const newWallet = await createWallet(sub, mintAddress, connection, db);

    // Insert the new wallet into the database
    const result = await db.collection("wallets").insertOne(newWallet);

    res.json({
      message: "Wallet and token account created and saved to the database.",
      walletId: result.insertedId,
      ...newWallet,
    });
  } catch (err) {
    console.error("Error during wallet creation:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------
// 3. Generate Many Wallets Endpoint
// ------------------------------------
router.post("/create_many", async (req, res) => {
  const { sub, wallet_quantity } = req.body.wallet_quantity;

  if (!wallet_quantity || wallet_quantity <= 0) {
    return res.status(400).json({ error: "Invalid wallet_quantity." });
  }

  try {
    const tokenMintAddress = new PublicKey(
      req.body.tokenMintAddress || USDC_MINT_ADDRESS
    );

    const tasks = [];
    for (let i = 0; i < wallet_quantity; i++) {
      tasks.push(async () => {
        const newWallet = await createWallet(
          sub,
          tokenMintAddress,
          connection,
          db
        );
        return newWallet;
      });
    }

    // Process in batches with throttling
    const batchSize = 10; // Number of parallel executions
    const rateLimitMs = 100; // Rate limit of 1 request per 100ms
    const wallets = [];

    while (tasks.length > 0) {
      const batch = tasks.splice(0, batchSize); // Take the next batch
      const batchResults = await Promise.all(
        batch.map(async (task, index) => {
          await sleep(index * rateLimitMs); // Stagger each task in the batch
          return task();
        })
      );
      wallets.push(...batchResults); // Collect results
    }

    await db.collection("wallets").insertMany(wallets);

    res.json({
      message: `${wallets.length} wallets created and saved to the database.`,
      walletsCreated: wallets.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------
// 2. Check Balance Endpoint
// ------------------------------------
router.get("/balance/:address", async (req, res) => {
  try {
    const address = new PublicKey(req.params.address);
    const balance = await connection.getBalance(address);
    res.json({ balance: balance / LAMPORTS_PER_SOL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/cumulative_balance", async (req, res) => {
  const sub = req.body.sub;

  try {
    // Fetch all wallet records from the DB
    const wallets = await db.collection("wallets").find({ sub }).toArray();

    let cumulativeBalance = 0;

    // Throttle requests to avoid rate limit errors (adjust sleep time as needed)
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const address = new PublicKey(wallet.publicKey);

      // Get the balance for each wallet
      const balance = await connection.getBalance(address);
      cumulativeBalance += balance;

      // Throttle the requests to avoid hitting rate limits
      if (i < wallets.length - 1) {
        await sleep(100); // Adjust sleep time if needed (100ms between requests)
      }
    }

    // Convert cumulative balance to SOL
    const cumulativeBalanceInSOL = cumulativeBalance / LAMPORTS_PER_SOL;

    // Respond with the cumulative balance
    res.json({ cumulativeBalance: cumulativeBalanceInSOL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/transfer", async (req, res) => {
  try {
    const { sub, senderSecretKey, recipientAddress, amount } = req.body;

    // Validate input
    if (!sub || !senderSecretKey || !recipientAddress || amount <= 0) {
      return res.status(400).json({ error: "Invalid input parameters." });
    }

    // Validate that the wallet belongs to the user
    const senderPublicKey = Keypair.fromSecretKey(
      Uint8Array.from(senderSecretKey.split(",").map(Number))
    ).publicKey.toBase58();

    const wallet = await db.collection("wallets").findOne({
      publicKey: senderPublicKey,
      sub,
    });

    if (!wallet) {
      return res.status(403).json({
        error:
          "Unauthorized transfer attempt. Wallet does not belong to the user.",
      });
    }

    // Convert amount to lamports
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    // Use the reusable transfer function
    const result = await performTransfer({
      senderSecretKey,
      recipientAddress,
      amount: lamports,
      connection,
    });

    res.json({
      message: "Transfer successful.",
      signature: result.signature,
    });
  } catch (err) {
    console.error("Error during transfer:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/transfer_one_to_many", async (req, res) => {
  const { sub, masterWalletSecretKey, percentage } = req.body;

  if (!sub || !masterWalletSecretKey || percentage <= 0 || percentage > 1) {
    return res.status(400).json({
      error:
        "Missing sub parameter or invalid master wallet secret key or percentage.",
    });
  }

  try {
    console.log("Starting transfer_one_to_many...");

    // Parse the master wallet secret key
    const secretKeyArray = masterWalletSecretKey.split(",").map(Number);
    const masterWallet = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    const masterPublicKey = masterWallet.publicKey.toBase58();

    // Validate that the master wallet belongs to the user
    const masterWalletData = await db.collection("wallets").findOne({
      publicKey: masterPublicKey,
      sub,
    });

    if (!masterWalletData) {
      return res.status(403).json({
        error:
          "Unauthorized access. Master wallet does not belong to the user.",
      });
    }

    // Get the balance of the master wallet
    const masterBalance = await connection.getBalance(masterWallet.publicKey);
    console.log(
      `Master wallet balance: ${masterBalance / LAMPORTS_PER_SOL} SOL`
    );

    // Transaction fee per signature (around 0.000005 SOL)
    const transactionFee = 0.000005 * LAMPORTS_PER_SOL;

    // Rent exemption per wallet (0.00203928 SOL)
    const rentExemptionBuffer = 0.002 * LAMPORTS_PER_SOL;

    // Calculate the amount to distribute based on the percentage
    const amountToDistribute = masterBalance * percentage - transactionFee;
    console.log(
      `Total amount to distribute: ${amountToDistribute / LAMPORTS_PER_SOL} SOL`
    );

    // Ensure there is enough balance to distribute
    if (amountToDistribute <= rentExemptionBuffer) {
      return res.status(400).json({
        error:
          "Master wallet balance is too low for the requested distribution.",
      });
    }

    // Fetch wallets associated with the same sub
    const wallets = await db.collection("wallets").find({ sub }).toArray();
    console.log(`Total wallets to process: ${wallets.length}`);

    if (wallets.length === 0) {
      return res.status(404).json({
        error: "No wallets found for the user.",
      });
    }

    // Calculate the maximum amount per wallet
    const maxAmount = Math.floor(amountToDistribute / wallets.length);
    let remainingAmount = amountToDistribute;

    const transferResults = [];
    const batchSize = 10; // Number of concurrent transfers
    const rateLimitMs = 100; // Delay between batches

    // Function to process a batch of transfers
    const processBatch = async (batch, batchIndex) => {
      console.log(
        `Processing batch ${batchIndex + 1} with ${batch.length} wallets...`
      );
      const batchResults = await Promise.all(
        batch.map(async (wallet, index) => {
          try {
            const amountToSend = Math.min(maxAmount, remainingAmount);
            remainingAmount -= amountToSend;

            // Log progress for each wallet in the batch
            console.log(
              `Batch ${batchIndex + 1}, Wallet ${index + 1}: Sending ${
                amountToSend / LAMPORTS_PER_SOL
              } SOL to ${wallet.publicKey}`
            );

            // Use the reusable transfer function
            const result = await performTransfer({
              senderSecretKey: masterWalletSecretKey, // Master wallet as sender
              recipientAddress: wallet.publicKey, // Current wallet as recipient
              amount: amountToSend, // Amount to send
              connection,
            });

            return {
              masterPublicKey: masterPublicKey,
              recipient: wallet.publicKey,
              signature: result.signature,
              amountSent: amountToSend,
            };
          } catch (err) {
            console.error(
              `Batch ${batchIndex + 1}, Wallet ${
                index + 1
              }: Failed to transfer to ${wallet.publicKey}: ${err.message}`
            );
            return {
              error: `Failed to transfer to wallet ${wallet.publicKey}: ${err.message}`,
            };
          }
        })
      );
      transferResults.push(...batchResults);
    };

    // Process wallets in batches
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize); // Get the next batch
      await processBatch(batch, Math.floor(i / batchSize));
      await sleep(rateLimitMs); // Throttle between batches
    }

    // Filter successful transfers
    const successfulTransfers = transferResults.filter(
      (result) => result && result.signature
    );

    console.log(
      `Transfer completed: ${successfulTransfers.length} successful transfers.`
    );
    res.json({
      message: `${successfulTransfers.length} wallets successfully received funds.`,
      transfers: successfulTransfers,
      failedTransfers: transferResults.filter(
        (result) => result && result.error
      ),
    });
  } catch (err) {
    console.error("Error in transfer_one_to_many:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/transfer_many_to_one", async (req, res) => {
  const { sub, recipientAddress, percentage } = req.body;

  if (!sub || !recipientAddress || percentage <= 0 || percentage > 1) {
    return res.status(400).json({
      error: "Missing sub parameter or invalid recipientAddress or percentage.",
    });
  }

  try {
    console.log("Starting transfer_many_to_one...");

    // Fetch all wallet records for the user from the DB
    const wallets = await db.collection("wallets").find({ sub }).toArray();
    console.log(`Total wallets to process: ${wallets.length}`);

    if (wallets.length === 0) {
      return res.status(404).json({
        error: "No wallets found for the user.",
      });
    }

    const transferResults = [];
    const rentExemptionAmount =
      await connection.getMinimumBalanceForRentExemption(0);
    const transactionFee = 5000; // Estimated fee in lamports
    const batchSize = 10; // Number of concurrent transfers
    const rateLimitMs = 100; // Delay between batches

    // Function to process a batch of transfers
    const processBatch = async (batch, batchIndex) => {
      console.log(
        `Processing batch ${batchIndex + 1} with ${batch.length} wallets...`
      );
      const batchResults = await Promise.all(
        batch.map(async (wallet, index) => {
          try {
            const senderPublicKey = new PublicKey(wallet.publicKey);
            const balance = await connection.getBalance(senderPublicKey);
            console.log(
              `Batch ${batchIndex + 1}, Wallet ${index + 1}: Wallet ${
                wallet.publicKey
              } balance: ${balance / LAMPORTS_PER_SOL} SOL`
            );

            const minRequiredBalance = rentExemptionAmount + transactionFee;
            const transferableBalance = balance - minRequiredBalance;
            if (transferableBalance <= 0) {
              console.log(
                `Batch ${batchIndex + 1}, Wallet ${index + 1}: Wallet ${
                  wallet.publicKey
                } has insufficient funds.`
              );
              return null;
            }

            const lamportsToTransfer = Math.floor(
              transferableBalance * percentage
            );
            if (lamportsToTransfer <= 0) {
              console.log(
                `Batch ${batchIndex + 1}, Wallet ${index + 1}: Wallet ${
                  wallet.publicKey
                } has no transferable balance.`
              );
              return null;
            }

            console.log(
              `Batch ${batchIndex + 1}, Wallet ${index + 1}: Transferring ${
                lamportsToTransfer / LAMPORTS_PER_SOL
              } SOL from wallet ${wallet.publicKey} to ${recipientAddress}`
            );

            const result = await performTransfer({
              senderSecretKey: wallet.secretKey,
              recipientAddress,
              amount: lamportsToTransfer,
              connection,
            });

            console.log(
              `Batch ${batchIndex + 1}, Wallet ${
                index + 1
              }: Transfer successful. Signature: ${result.signature}`
            );

            return {
              publicKey: wallet.publicKey,
              signature: result.signature,
            };
          } catch (err) {
            console.error(
              `Batch ${batchIndex + 1}, Wallet ${
                index + 1
              }: Failed to transfer from wallet ${wallet.publicKey}: ${
                err.message
              }`
            );
            return {
              error: `Failed to transfer from wallet ${wallet.publicKey}: ${err.message}`,
            };
          }
        })
      );
      transferResults.push(...batchResults.filter((result) => result !== null));
    };

    // Process wallets in batches
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize); // Get the next batch
      await processBatch(batch, Math.floor(i / batchSize));
      await sleep(rateLimitMs); // Throttle between batches
    }

    // Filter successful transfers
    const successfulTransfers = transferResults.filter(
      (result) => result && result.signature
    );

    console.log(
      `Transfer completed: ${successfulTransfers.length} successful transfers out of ${wallets.length} wallets.`
    );

    res.json({
      message: `${successfulTransfers.length} wallets successfully transferred funds.`,
      transfers: successfulTransfers,
      failedTransfers: transferResults.filter(
        (result) => result && result.error
      ),
    });
  } catch (err) {
    console.error("Error in transfer_many_to_one:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/wrap_sol", async (req, res) => {
  const { sub, walletSecretKey, percentage } = req.body;

  if (!sub || !walletSecretKey || percentage <= 0 || percentage > 1) {
    return res.status(400).json({ error: "Invalid input parameters." });
  }

  try {
    console.log("Initializing wrap SOL process...");

    // Parse wallet secret key and create Keypair
    const secretKeyArray = walletSecretKey.split(",").map(Number);
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    const walletPublicKey = wallet.publicKey.toBase58();

    // Validate that the wallet belongs to the user
    const walletData = await db.collection("wallets").findOne({
      publicKey: walletPublicKey,
      sub,
    });

    if (!walletData) {
      return res.status(403).json({
        error: "Unauthorized operation. Wallet does not belong to the user.",
      });
    }

    // Fetch wallet SOL balance
    const solBalance = await connection.getBalance(wallet.publicKey);
    console.log(`Wallet SOL balance: ${solBalance / LAMPORTS_PER_SOL} SOL`);

    // Calculate the amount to wrap into wSOL
    const amountToWrap = Math.floor(solBalance * percentage);
    if (amountToWrap <= 0) {
      throw new Error("Calculated wSOL amount is too low to wrap.");
    }
    console.log(
      `Amount to wrap into wSOL: ${amountToWrap / LAMPORTS_PER_SOL} SOL`
    );

    // Wrap SOL into wSOL
    const associatedTokenAccount = await wrapSol(wallet, amountToWrap);

    res.json({
      message: "SOL successfully wrapped into wSOL.",
      wrappedAmount: amountToWrap / LAMPORTS_PER_SOL,
      associatedTokenAccount: associatedTokenAccount.toBase58(),
    });
  } catch (err) {
    console.error("Error during wrap SOL process:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/token_accounts_balance/:publicKey", async (req, res) => {
  const walletPublicKey = req.params.publicKey;

  if (!walletPublicKey) {
    return res
      .status(400)
      .json({ error: "Missing walletPublicKey parameter." });
  }

  try {
    console.log("Fetching token accounts balance...");

    // Retrieve wallet data from the database
    const walletData = await db
      .collection("wallets")
      .findOne({ publicKey: walletPublicKey });

    if (!walletData || !walletData.tokenAccounts) {
      throw new Error("Wallet or token accounts not found in the database.");
    }

    const { tokenAccounts } = walletData;
    const balances = [];

    // Fetch balance for each token account
    for (const account of tokenAccounts) {
      const accountBalanceInfo = await connection.getTokenAccountBalance(
        new PublicKey(account.tokenAccount)
      );

      balances.push({
        tokenAccount: account.tokenAccount,
        tokenMintAddress: account.tokenMintAddress,
        balance: accountBalanceInfo.value.uiAmount || 0,
      });
    }

    res.json({
      message: "Token accounts balance fetched successfully.",
      balances,
    });
  } catch (err) {
    console.error("Error fetching token accounts balance:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/swap", async (req, res) => {
  const { inputToken, outputToken, walletSecretKey, percentage } = req.body;

  if (
    !inputToken ||
    !outputToken ||
    !walletSecretKey ||
    percentage <= 0 ||
    percentage > 1
  ) {
    return res.status(400).json({ error: "Invalid input parameters." });
  }

  try {
    console.log("Initializing Raydium SDK and starting swap...");

    // Parse wallet secret key and create Keypair
    const secretKeyArray = walletSecretKey.split(",").map(Number);
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

    // Retrieve wallet data from the database
    const walletData = await db
      .collection("wallets")
      .findOne({ publicKey: wallet.publicKey.toBase58() });

    if (!walletData || !walletData.tokenAccounts) {
      throw new Error("Wallet or token accounts not found in the database.");
    }

    const { tokenAccounts } = walletData;

    // Retrieve the input and output token accounts from the stored tokenAccounts array
    const inputTokenAccount = tokenAccounts.find(
      (account) => account.tokenMintAddress === inputToken
    );

    let outputTokenAccount = tokenAccounts.find(
      (account) => account.tokenMintAddress === outputToken
    );

    if (!inputTokenAccount) {
      throw new Error(`Input token account for mint ${inputToken} not found.`);
    }

    console.log(`Input token account: ${inputTokenAccount.tokenAccount}`);

    if (!outputTokenAccount) {
      console.log(
        `Output token account for mint ${outputToken} not found. Creating it.`
      );

      const outputTokenMint = new PublicKey(outputToken);

      const masterWallet = await db
        .collection("wallets")
        .findOne({ master: true });

      if (!masterWallet) {
        throw new Error("Master wallet not found for creating token account.");
      }

      const secretKeyArray = masterWallet.secretKey.split(",").map(Number);
      const feePayer = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

      console.log("A");

      const outputTokenAta = await createAssociatedTokenAccount(
        connection,
        feePayer,
        outputTokenMint,
        wallet.publicKey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          feePayer.publicKey, // Payer
          outputTokenAta, // Associated Token Account
          wallet.publicKey, // Owner
          outputTokenMint, // Mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      console.log("B");

      await sendAndConfirmTransaction(connection, transaction, [feePayer]);
      console.log(
        `Associated token account created: ${outputTokenAta.toBase58()}`
      );

      console.log("C");

      // Add the new output token account to the database
      const newTokenAccount = {
        tokenAccount: outputTokenAta.toBase58(),
        tokenMintAddress: outputToken,
      };

      await db
        .collection("wallets")
        .updateOne(
          { publicKey: wallet.publicKey.toBase58() },
          { $push: { tokenAccounts: newTokenAccount } }
        );

      // Update outputTokenAccount in the current scope
      outputTokenAccount = newTokenAccount;
    }

    // Fetch the actual balance dynamically
    const accountBalanceInfo = await connection.getTokenAccountBalance(
      new PublicKey(inputTokenAccount.tokenAccount)
    );

    console.log(accountBalanceInfo);

    const inputBalance = parseInt(accountBalanceInfo.value.amount || "0");
    console.log(`Fetched input token balance: ${inputBalance}`);

    // Calculate swap amount
    const swapAmount = Math.floor(inputBalance * percentage);
    if (swapAmount <= 0) {
      throw new Error(
        `Calculated swap amount (${swapAmount}) is too low. Check balance or percentage.`
      );
    }

    console.log(`Swapping ${swapAmount} of ${inputToken} for ${outputToken}`);

    // Initialize Raydium SDK
    const raydium = await Raydium.load({
      connection,
      owner: wallet,
    });

    console.log("A");

    console.log("Raydium SDK initialized.");

    // Fetch the Raydium pool for the given token pair
    const poolInfo = await raydium.api.fetchPoolByMints({
      mint1: inputToken,
      mint2: outputToken,
    });

    if (!poolInfo.data.length) {
      throw new Error(
        `No Raydium pool found for ${inputToken} and ${outputToken}.`
      );
    }

    const pool = poolInfo.data[0];
    console.log(`Using Raydium pool: ${pool.id}`);

    // Perform the swap
    const transaction = await Raydium.swap({
      connection,
      owner: wallet,
      poolKeys: pool,
      tokenAccounts,
      amountIn: swapAmount,
      minAmountOut: 0, // Set slippage tolerance appropriately
    });

    console.log(`Swap transaction signature: ${transaction}`);

    res.json({
      message: "Swap successful.",
      signature: transaction,
      swappedAmount: swapAmount,
    });
  } catch (err) {
    console.error("Error during swap:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
