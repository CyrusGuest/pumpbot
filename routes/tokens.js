const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} = require("@solana/spl-token");
const {
  Keypair,
  Connection,
  clusterApiUrl,
  PublicKey,
} = require("@solana/web3.js");
const express = require("express");
const db = require("../db/connection.js");
const BN = require("bn.js");
const {
  txVersion,
  AMM_V4,
  OPEN_BOOK_PROGRAM,
  Raydium,
} = require("@raydium-io/raydium-sdk-v2");

const router = express.Router();

const wSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ------------------------------------
// 4. Create SPL Token Endpoint
// ------------------------------------
router.post("/create", async (req, res) => {
  try {
    const { payerSecretKey, decimals, initialSupply, tokenName } = req.body;
    const secretKeyArray = payerSecretKey.split(",").map(Number);
    const payer = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

    // Create Token
    const token = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      decimals
    );

    console.log("Token created");

    // Create Associated Token Account
    const associatedTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      token,
      payer.publicKey
    );

    // Mint Initial Supply
    await mintTo(
      connection,
      payer,
      token,
      associatedTokenAccount.address,
      payer,
      initialSupply * Math.pow(10, decimals)
    );

    // Initialize Raydium SDK
    const raydium = await Raydium.load({
      connection,
      owner: payer,
    });

    // Create a Market
    const { execute: executeMarket, extInfo: marketExtInfo } =
      await raydium.marketV2.create({
        baseInfo: { mint: token, decimals },
        quoteInfo: { mint: new PublicKey(wSOL_MINT_ADDRESS), decimals: 9 }, // WSOL as quote token
        lotSize: 1,
        tickSize: 0.01,
        dexProgramId: OPEN_BOOK_PROGRAM,
        txVersion,
      });

    const marketTxIds = await executeMarket({ sequentially: true });
    console.log("Market created with transaction IDs:", marketTxIds);

    console.log("MarketInfo" + marketExtInfo.address.market);

    // Get market ID
    const marketId = marketExtInfo.address.market.toBase58();

    // Create an AMM Pool
    const { execute: executePool, extInfo: poolExtInfo } =
      await raydium.liquidity.createPoolV4({
        programId: AMM_V4,
        marketInfo: {
          marketId: new PublicKey(marketId),
          programId: OPEN_BOOK_PROGRAM,
        },
        baseMintInfo: { mint: token, decimals },
        quoteMintInfo: { mint: new PublicKey(wSOL_MINT_ADDRESS), decimals: 9 },
        baseAmount: new BN(1 * Math.pow(10, decimals)), // All minted tokens as initial liquidity
        quoteAmount: new BN(1), // Arbitrary WSOL liquidity
        startTime: new BN(0),
        ownerInfo: { useSOLBalance: true },
        associatedOnly: false,
        txVersion,
      });

    const poolTxIds = await executePool({ sendAndConfirm: true });
    console.log("AMM Pool created with transaction ID:", poolTxIds);

    // Prepare token details to store in the database
    const tokenDetails = {
      name: tokenName || "Unnamed Token",
      tokenAddress: token.toBase58(),
      mintAuthority: payer.publicKey.toBase58(),
      decimals: decimals,
      initialSupply: initialSupply,
      associatedAccount: associatedTokenAccount.address.toBase58(),
      marketId,
      poolKeys: poolExtInfo.address,
      createdAt: new Date(),
    };

    // Insert token details into the "tokens" collection
    await db.collection("tokens").insertOne(tokenDetails);

    // Update wallet in the "wallets" collection
    await db.collection("wallets").updateOne(
      { publicKey: payer.publicKey.toBase58() },
      {
        $push: {
          tokenAccounts: {
            tokenAccount: associatedTokenAccount.address.toBase58(),
            tokenMintAddress: token.toBase58(),
            balance: initialSupply,
          },
        },
      }
    );

    res.json({
      message: "Token, market, and pool created successfully.",
      tokenDetails,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
