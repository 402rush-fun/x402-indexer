# 🎰 Block Payment Allocation - Lottery System

## Overview

This system implements a **fair lottery mechanism** to allocate limited mint slots across multiple payment transactions within a block. When demand exceeds supply, the system randomly selects winners while ensuring fairness through a two-stage randomization process.

## 🎯 Key Constraints

| Constraint                  | Value                     | Description                                        |
| --------------------------- | ------------------------- | -------------------------------------------------- |
| **MAX_ADDRESSES_PER_BLOCK** | 80                        | Maximum unique addresses that can win per block    |
| **remainingSlots**          | Dynamic                   | Based on token's `max_mint_count - current_minted` |
| **Effective Limit**         | `min(80, remainingSlots)` | Actual number of allocations per block             |

## 🔄 The Lottery Process

### Stage 1: Address-Level Selection (Fairness Layer)

**Goal**: Give each unique address an equal chance, regardless of how many transactions they submitted.

```
Block #12345 - Token: 0xABC...
═══════════════════════════════════════════════════════════

PENDING PAYMENTS (Before Lottery):
┌─────────────┬────────────────┬─────────┐
│   Address   │  Transactions  │  Count  │
├─────────────┼────────────────┼─────────┤
│  Alice      │  tx1, tx2, tx3 │    3    │
│  Bob        │  tx4           │    1    │
│  Charlie    │  tx5, tx6      │    2    │
│  David      │  tx7, tx8      │    2    │
│  Eve        │  tx9           │    1    │
└─────────────┴────────────────┴─────────┘

Total: 5 unique addresses, 9 transactions
```

**Random Shuffle & Selection** (assuming maxToAllocate = 3):

```
┌──────────────────────────────────────────┐
│  SHUFFLE ADDRESSES (Fisher-Yates)       │
├──────────────────────────────────────────┤
│  [Alice, Bob, Charlie, David, Eve]      │
│              ↓ Random Shuffle           │
│  [David, Alice, Eve, Bob, Charlie]      │
│              ↓ Select First 3           │
│  [David, Alice, Eve] ✅ SELECTED        │
└──────────────────────────────────────────┘
```

**Result**: Each address had a **3/5 (60%) chance** of being selected, regardless of transaction count.

### Stage 2: Transaction-Level Selection (Within Winners)

**Goal**: For addresses with multiple transactions, randomly pick ONE transaction.

```
SELECTED ADDRESSES & THEIR TXS:
┌─────────────┬────────────────┬──────────────────┐
│   Address   │  All Txs       │  Random Pick     │
├─────────────┼────────────────┼──────────────────┤
│  David      │  tx7, tx8      │  tx8  ✅         │
│  Alice      │  tx1, tx2, tx3 │  tx2  ✅         │
│  Eve        │  tx9           │  tx9  ✅         │
└─────────────┴────────────────┴──────────────────┘

FINAL ALLOCATIONS: [tx8, tx2, tx9]
```

### Stage 3: Filling Remaining Slots (If Applicable)

If `selectedTxs.length < maxToAllocate`, the system picks randomly from remaining transactions.

```
IF maxToAllocate = 5 (but only 3 addresses selected):
┌─────────────────────────────────────────┐
│  Need 2 more slots                      │
│  Remaining txs: [tx1, tx3, tx4, tx5,    │
│                  tx6, tx7]              │
│              ↓ Shuffle & Pick 2         │
│  Additional: [tx5, tx1] ✅              │
└─────────────────────────────────────────┘

FINAL: [tx8, tx2, tx9, tx5, tx1] - 5 allocated
```

## 📊 Complete Example Walkthrough

### Scenario Setup

```
Token: MEME Token (0xDEF...)
├─ max_mint_count: 1000
├─ current_minted: 945
└─ remaining_slots: 55

Block #20001 Payments:
├─ 120 pending transactions
└─ 95 unique addresses

Effective Limit: min(80, 55) = 55 allocations
```

### Step-by-Step Execution

#### 1️⃣ **Input Analysis**

```
┌────────────────────────────────────────┐
│  📥 INPUT STATS                        │
├────────────────────────────────────────┤
│  Unique Addresses:      95             │
│  Total Transactions:    120            │
│  MAX_ADDRESSES:         80             │
│  Remaining Slots:       55             │
│  ➜ maxToAllocate:       55             │
└────────────────────────────────────────┘
```

#### 2️⃣ **Address Lottery**

```
95 addresses > 55 maxToAllocate
➜ Run lottery to select 55 winners

[Address_1, Address_2, ..., Address_95]
           ↓ Fisher-Yates Shuffle
[Address_42, Address_7, ..., Address_91]
           ↓ Take First 55
✅ 55 addresses selected
```

#### 3️⃣ **Transaction Selection**

```
For each of the 55 selected addresses:
  ├─ If address has 1 tx  ➜ select that tx
  └─ If address has N txs ➜ random.pick(1)

Example:
  Address_42 has [tx_105, tx_106, tx_107]
  ➜ Random pick: tx_106 ✅
```

#### 4️⃣ **Final Allocation**

```
┌────────────────────────────────────────┐
│  ✅ ALLOCATION RESULTS                 │
├────────────────────────────────────────┤
│  ALLOCATED:     55 txs                 │
│  REJECTED:      65 txs                 │
│                                        │
│  New Minted Total: 945 + 55 = 1000    │
│  Status: ⚠️  MAX MINT REACHED          │
└────────────────────────────────────────┘
```

## 🎲 Randomization Algorithm

### Fisher-Yates Shuffle

The system uses the industry-standard **Fisher-Yates shuffle** for unbiased randomization:

```typescript
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];

  // Start from the end
  for (let i = shuffled.length - 1; i > 0; i--) {
    // Pick random index from 0 to i
    const j = Math.floor(Math.random() * (i + 1));

    // Swap elements
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}
```

**Properties**:

- ⚡ Time Complexity: O(n)
- 🎯 Every permutation has equal probability: 1/n!
- ✅ Cryptographically fair for non-adversarial use

## 📈 Probability Analysis

### Individual Address Win Probability

```
P(address wins) = min(1, maxToAllocate / totalUniqueAddresses)
```

**Examples**:

| Unique Addresses | maxToAllocate | Win Probability |
| ---------------- | ------------- | --------------- |
| 50               | 80            | 100% (all win)  |
| 80               | 80            | 100% (all win)  |
| 100              | 80            | 80%             |
| 200              | 80            | 40%             |
| 500              | 50            | 10%             |

### Transaction Win Probability (Multi-Tx Address)

If an address submits N transactions:

```
P(specific tx wins | address wins) = 1/N

P(specific tx wins) = P(address wins) × (1/N)
```

**Example**: Alice submits 5 transactions when total unique addresses = 100, maxToAllocate = 80:

```
P(Alice wins)     = 80/100 = 80%
P(each tx wins)   = 80% × (1/5) = 16%
```

## 🚫 Rejection Scenarios

### Scenario A: Block Limit Exceeded

```
┌────────────────────────────────────────┐
│  Status: REJECTED                      │
│  Error:  "Block allocation limit       │
│          exceeded"                     │
├────────────────────────────────────────┤
│  Cause: Not selected in lottery        │
│  (more addresses than available slots) │
└────────────────────────────────────────┘
```

### Scenario B: Max Mint Reached

```
┌────────────────────────────────────────┐
│  Status: REJECTED                      │
│  Error:  "Token max mint count         │
│          reached (1000)"               │
├────────────────────────────────────────┤
│  Cause: Token fully minted             │
│  All future txs automatically rejected │
└────────────────────────────────────────┘
```

### Scenario C: Pool Already Created

```
┌────────────────────────────────────────┐
│  Status: REJECTED                      │
│  Error:  "Token pool already created"  │
├────────────────────────────────────────┤
│  Cause: Minting phase ended            │
│  Token now tradeable on DEX            │
└────────────────────────────────────────┘
```

## 🔍 Edge Cases Handled

### Case 1: Fewer Addresses Than Limit

```
Situation: 30 unique addresses, maxToAllocate = 80

Result: ✅ All 30 addresses win (no lottery needed)
```

### Case 2: Address Has Multiple Txs, But Only 1 Wins

```
Bob submits: [tx_1, tx_2, tx_3, tx_4, tx_5]
Bob wins address lottery ➜ Random pick: tx_3
Status:
  ✅ tx_3  → ALLOCATED
  🚫 tx_1, tx_2, tx_4, tx_5 → REJECTED
```

### Case 3: Remaining Slots After Address Selection

```
Selected 40 addresses (each contributed 1 tx = 40 txs)
maxToAllocate = 55 ➜ 15 slots remaining

➜ System randomly picks 15 more from rejected txs
➜ Fills all 55 slots
```

### Case 4: Exact Match

```
50 unique addresses, maxToAllocate = 50

Result: ✅ All addresses win, no Stage 3 needed
```

## 🔄 Multi-Token Blocks

When a block contains payments to multiple tokens:

```
Block #30000
├─ Token A (0xAAA...)
│  ├─ 60 unique addresses → 55 allocated
│  └─ Independent lottery
├─ Token B (0xBBB...)
│  ├─ 150 unique addresses → 80 allocated
│  └─ Independent lottery
└─ Token C (0xCCC...)
   ├─ 20 unique addresses → 20 allocated (all win)
   └─ No lottery needed

⚠️  Same address can win in multiple token lotteries
```

## 📝 Status Transitions

```
     PENDING
        │
        ↓
    ┌───┴────┐
    │ LOTTERY│
    └───┬────┘
        │
    ┌───┴────────────┐
    ↓                ↓
ALLOCATED        REJECTED
    │                │
    ↓                ↓
MINT_PROCESSING   (refunded)
    │
┌───┴────┐
↓        ↓
MINT_    MINT_
COMPLETED ERROR
```

## 🎯 Fairness Guarantees

✅ **Equal address opportunity**: Each unique address has equal probability

✅ **Spam protection**: Submitting multiple txs doesn't increase win chance

✅ **True randomness**: Fisher-Yates ensures unbiased selection

✅ **First-come advantage removed**: Block order doesn't matter, only randomness

✅ **Multi-token isolation**: Each token runs independent lottery

## 🔧 Configuration

```typescript
// In allocate-block-payments.ts
const MAX_ADDRESSES_PER_BLOCK = 80; // Adjust based on gas limits

// Cron schedule (every 2 seconds)
const job = new CronJob("*/2 * * * * *", ...);
```

## 📊 Monitoring & Logs

Sample log output:

```
[allocate-block-payments] 📋 Found 5 blocks with pending payments
[allocate-block-payments] 📍 Block range: 20000 -> 20004
[allocate-block-payments] 🎯 Found 3 tokens in block 20000
[allocate-block-payments] 📊 Token 0xDEF...: 945/1000 minted, 55 slots remaining
[allocate-block-payments] ✅ Block 20000, token 0xDEF...: 55 selected, 65 rejected (1000/1000 total)
[allocate-block-payments] ✅ Allocation complete! Total: 155 selected, 180 refunded
```

## 🎲 Try It Yourself

Want to simulate the lottery? Here's a simple visualization:

```typescript
// Simulate 10 addresses competing for 5 slots
const addresses = Array.from({ length: 10 }, (_, i) => `Addr_${i + 1}`);
const shuffled = shuffleArray(addresses);
const winners = shuffled.slice(0, 5);

console.log("🎰 Lottery Results:");
console.log("Winners:", winners);
console.log("Probability:", "5/10 = 50% per address");
```

---

## 🤝 Summary

The lottery system ensures:

1. **Fairness**: Equal chance for all unique participants
2. **Scarcity Management**: Respects token mint limits
3. **Gas Efficiency**: Caps allocations per block
4. **True Randomness**: Unbiased Fisher-Yates algorithm
5. **Transparency**: Clear rejection reasons

**The bottom line**: Everyone gets a fair shot, but luck determines the winners! 🎰✨
