import { Op } from "sequelize";
import {
  PaymentModel,
  NetworkEnum,
  PaymentStatusEnum,
} from "models/payment.model";
import { TokenModel } from "models/token.model";
import { CronJob } from "cron";
import { CronRunner } from "core/cron/cron-runner";
import { NETWORK_NAME } from "constants";

const CRON_NAME = "allocate-block-payments";
const MAX_ADDRESSES_PER_BLOCK = 80;

/**
 * Shuffle array using Fisher-Yates algorithm
 */
const shuffleArray = <T>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

/**
 * Process payments for a specific block and token
 */
const processBlockToken = async (
  blockNumber: number,
  tokenAddress: string,
  network: NetworkEnum
) => {
  // Get token info to check max_mint_count and pool_created
  const token = await TokenModel.findOne({
    where: { address: tokenAddress },
  });

  if (!token) {
    console.log(
      `[${CRON_NAME}] ⚠️  Token ${tokenAddress} not found in database`
    );
    return { selected: 0, refunded: 0 };
  }

  // Check if pool already created
  if (token.dataValues.pool_created) {
    console.log(
      `[${CRON_NAME}] 🚫 Token ${tokenAddress} pool already created, rejecting all pending payments`
    );

    // Mark all pending payments for this token as REJECTED
    await PaymentModel.update(
      {
        status: PaymentStatusEnum.REJECTED,
        error: "REJECTED: Token pool already created",
      },
      {
        where: {
          block_number: blockNumber,
          to: tokenAddress,
          network: network,
          status: PaymentStatusEnum.PENDING,
        },
      }
    );

    return { selected: 0, refunded: 0 };
  }

  const maxMintCount = parseInt(token.dataValues.max_mint_count || "0");

  // Count how many payments are already ALLOCATED for this token
  const allocatedCountFrDb = await PaymentModel.count({
    where: {
      to: tokenAddress,
      network: network,
      status: [
        PaymentStatusEnum.ALLOCATED,
        PaymentStatusEnum.MINT_PROCESSING,
        PaymentStatusEnum.MINT_COMPLETED,
        PaymentStatusEnum.MINT_ERROR,
      ],
    },
  });

  const mintedCount = Math.max(
    allocatedCountFrDb,
    Number(token.dataValues.mint_count || 0)
  );

  // Calculate how many more can be allocated
  const remainingSlots = maxMintCount - mintedCount;

  if (remainingSlots <= 0) {
    console.log(
      `[${CRON_NAME}] 🚫 Token ${tokenAddress} has reached max mint count (${maxMintCount}/${maxMintCount})`
    );

    // Mark all pending payments for this token as REJECTED
    await PaymentModel.update(
      {
        status: PaymentStatusEnum.REJECTED,
        error: "REJECTED: Token has reached maximum mint count",
      },
      {
        where: {
          block_number: blockNumber,
          to: tokenAddress,
          network: network,
          status: PaymentStatusEnum.PENDING,
        },
      }
    );

    return { selected: 0, refunded: 0 };
  }

  console.log(
    `[${CRON_NAME}] 📊 Token ${tokenAddress}: ${mintedCount}/${maxMintCount} minted, ${remainingSlots} slots remaining`
  );

  // Get all payments for this block and token that haven't been processed yet
  const payments = await PaymentModel.findAll({
    where: {
      block_number: blockNumber,
      to: tokenAddress,
      network: network,
      status: PaymentStatusEnum.PENDING, // Only process pending payments
    },
  });

  if (payments.length === 0) {
    console.log(
      `[${CRON_NAME}]  ℹ️  No payments found for block ${blockNumber}, token ${tokenAddress}`
    );
    return { selected: 0, refunded: 0 };
  }

  // Get unique addresses (from)
  const addressMap = new Map<string, string[]>(); // address -> [tx1, tx2, ...]
  payments.forEach((payment) => {
    const addr = payment.dataValues.from.toLowerCase();
    if (!addressMap.has(addr)) {
      addressMap.set(addr, []);
    }
    addressMap.get(addr)!.push(payment.dataValues.tx);
  });

  const uniqueAddresses = Array.from(addressMap.keys());

  // Calculate the maximum number of payments we can allocate
  // Limited by both MAX_ADDRESSES_PER_BLOCK and remainingSlots
  const maxToAllocate = Math.min(MAX_ADDRESSES_PER_BLOCK, remainingSlots);

  // Step 1: Randomly select up to maxToAllocate unique addresses
  let selectedAddresses: string[] = [];

  if (uniqueAddresses.length <= maxToAllocate) {
    // If we have fewer than or equal to MAX, select all unique addresses
    selectedAddresses = uniqueAddresses;
  } else {
    // If we have more than MAX, randomly select MAX addresses
    const shuffled = shuffleArray(uniqueAddresses);
    selectedAddresses = shuffled.slice(0, maxToAllocate);
  }

  // Step 2: For each selected address, randomly pick ONE transaction
  const selectedTxs: string[] = [];
  for (const address of selectedAddresses) {
    const txsForAddress = addressMap.get(address)!;
    // Randomly pick one tx from this address
    const randomTx =
      txsForAddress[Math.floor(Math.random() * txsForAddress.length)];
    selectedTxs.push(randomTx);
  }

  // Step 3: If we still need more (< maxToAllocate), pick randomly from remaining txs
  if (selectedTxs.length < maxToAllocate) {
    const allTxs = payments.map((p) => p.dataValues.tx);
    const remainingTxs = allTxs.filter((tx) => !selectedTxs.includes(tx));

    if (remainingTxs.length > 0) {
      const shuffledRemaining = shuffleArray(remainingTxs);
      const needed = maxToAllocate - selectedTxs.length;
      const additionalTxs = shuffledRemaining.slice(0, needed);
      selectedTxs.push(...additionalTxs);
    }
  }

  // Step 4: Mark selected transactions as success, others as refund
  const refundedTxs = payments
    .map((p) => p.dataValues.tx)
    .filter((tx) => !selectedTxs.includes(tx));

  // Update selected transactions - mark as ALLOCATED
  if (selectedTxs.length > 0) {
    await PaymentModel.update(
      {
        status: PaymentStatusEnum.ALLOCATED,
      },
      {
        where: {
          tx: {
            [Op.in]: selectedTxs,
          },
        },
      }
    );
  }

  // Update refunded transactions - mark as REJECTED
  if (refundedTxs.length > 0) {
    // Determine rejection reason
    const reachedMaxMint = mintedCount + selectedTxs.length >= maxMintCount;
    const errorMessage = reachedMaxMint
      ? `REJECTED: Token max mint count reached (${maxMintCount})`
      : "REJECTED: Block allocation limit exceeded";

    await PaymentModel.update(
      {
        status: PaymentStatusEnum.REJECTED,
        error: errorMessage,
      },
      {
        where: {
          tx: {
            [Op.in]: refundedTxs,
          },
        },
      }
    );
  }

  const newAllocatedCount = mintedCount + selectedTxs.length;
  console.log(
    `[${CRON_NAME}] ✅ Block ${blockNumber}, token ${tokenAddress}: ${selectedTxs.length} selected, ${refundedTxs.length} rejected (${newAllocatedCount}/${maxMintCount} total)`
  );

  return { selected: selectedTxs.length, refunded: refundedTxs.length };
};

/**
 * Process a single block - find all tokens and process each
 */
const processBlock = async (blockNumber: number, network: NetworkEnum) => {
  // Find all unique token addresses (to) in this block with PENDING status
  const payments = await PaymentModel.findAll({
    where: {
      block_number: blockNumber,
      network: network,
      status: PaymentStatusEnum.PENDING,
    },
    attributes: ["to"],
    group: ["to"],
  });

  const uniqueTokens = [...new Set(payments.map((p) => p.dataValues.to))];

  if (uniqueTokens.length === 0) {
    console.log(`[${CRON_NAME}]  ℹ️  No tokens found in block ${blockNumber}`);
    return { totalSelected: 0, totalRefunded: 0 };
  }

  console.log(
    `[${CRON_NAME}] 🎯 Found ${uniqueTokens.length} tokens in block ${blockNumber}`
  );

  let totalSelected = 0;
  let totalRefunded = 0;

  // Process each token separately
  for (const tokenAddress of uniqueTokens) {
    const result = await processBlockToken(blockNumber, tokenAddress, network);
    totalSelected += result.selected;
    totalRefunded += result.refunded;
  }

  return { totalSelected, totalRefunded };
};

/**
 * Main sync function
 */
const allocateBlockPayments = async () => {
  try {
    // Get the current network from environment
    const network =
      NETWORK_NAME === "testnet" ? NetworkEnum.BASE_SEPOLIA : NetworkEnum.BASE;

    // Find all blocks that have PENDING payments (oldest first)
    const pendingBlocks = await PaymentModel.findAll({
      where: {
        network: network,
        status: PaymentStatusEnum.PENDING,
      },
      attributes: ["block_number"],
      group: ["block_number"],
      order: [["block_number", "ASC"]], // Process from oldest block first
      raw: true,
    });

    if (pendingBlocks.length === 0) {
      console.log(`[${CRON_NAME}]  ℹ️  No pending payments found to process`);
      return;
    }

    const blocksToProcess = pendingBlocks.map((b: any) => b.block_number);
    console.log(
      `[${CRON_NAME}] 📋 Found ${blocksToProcess.length} blocks with pending payments`
    );
    console.log(
      `[${CRON_NAME}] 📍 Block range: ${blocksToProcess[0]} -> ${
        blocksToProcess[blocksToProcess.length - 1]
      }`
    );

    // Process blocks from oldest to newest
    let totalSelected = 0;
    let totalRefunded = 0;

    for (const blockNumber of blocksToProcess) {
      try {
        const result = await processBlock(blockNumber, network);
        totalSelected += result.totalSelected;
        totalRefunded += result.totalRefunded;
      } catch (error) {
        console.error(
          `[${CRON_NAME}] ❌ Error processing block ${blockNumber}:`,
          error
        );
        // Continue to next block on error
      }
    }

    console.log(
      `[${CRON_NAME}] ✅ Allocation complete! Total: ${totalSelected} selected, ${totalRefunded} refunded`
    );
  } catch (error) {
    console.error(`[${CRON_NAME}] ❌ Error in allocateBlockPayments:`, error);
  }
};

/**
 * Start the allocation cron job
 */
export const startAllocateBlockPayments = () => {
  const cronRunner = new CronRunner(CRON_NAME, false, allocateBlockPayments);

  // Cron pattern: every 5 seconds
  const job = new CronJob(
    "*/2 * * * * *",
    cronRunner.run,
    null,
    true,
    "Etc/UTC"
  );

  job.start();
  console.log(`[${CRON_NAME}] 🕐 Cron job started (runs every 5 seconds)`);
};
