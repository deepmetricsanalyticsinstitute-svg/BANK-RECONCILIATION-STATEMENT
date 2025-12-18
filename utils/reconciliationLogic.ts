import { Transaction, ReconciliationResult, MatchGroup } from '../types';

// Configurable tolerances
const DEFAULT_CONFIG = {
  amountTolerance: 0.01,           // Max difference for "exact" amount match
  dateWindowStrict: 3,             // Days (+/-) for strict matches (nearby)
  dateWindowLoose: 10,             // Days (+/-) for fuzzy matches
  dateWindowReference: 45,         // Days (+/-) allowed if a strong Reference ID matches (e.g. Cheques)
  fuzzyTextThreshold: 0.6,         // Minimum similarity score (0-1) to accept a match
  maxCombinationDepth: 4           // Max items for 1-to-N logic
};

// Expanded list of common banking terms to ignore during text comparison
const STOP_WORDS = new Set([
  'the', 'and', 'or', 'ltd', 'inc', 'corp', 'plc', 'llc', 'gmbh', 'pvt',
  'payment', 'transfer', 'tfr', 'inv', 'ref', 'invoice', 'bill', 'reference',
  'to', 'from', 'of', 'for', 'by', 'deposit', 'withdrawal', 'dr', 'cr',
  'momo', 'mobile', 'money', 'bank', 'charges', 'service', 'fee', 'comm',
  'pos', 'purchase', 'card', 'visa', 'mastercard', 'direct', 'debit', 
  'standing', 'order', 'chq', 'cheque', 'cash', 'atm', 'trf', 'rtgs', 'neft', 
  'imps', 'ach', 'wire', 'txn', 'id', 'no', 'number', 'account', 'acct',
  'opening', 'balance', 'closing', 'brought', 'forward'
]);

// --- Helper Functions ---

const getDaysDiff = (d1: string, d2: string) => 
  Math.abs(new Date(d1).getTime() - new Date(d2).getTime()) / (1000 * 60 * 60 * 24);

const normalizeStr = (str: string) => {
  // Lowercase, remove special chars but keep alphanumerics and spaces
  // We keep hyphens inside words to preserve "INV-102" style IDs if needed, 
  // but simpler to just strip for general word matching.
  const clean = str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return clean.split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .join(' ');
};

const extractNumericTokens = (str: string): Set<string> => {
  // Capture:
  // 1. Pure digits of length 3+ (e.g. 1024, 50020)
  // 2. Alphanumeric codes containing at least 2 digits (e.g. INV204, Ref-550)
  // We exclude common year-like numbers (2020-2030) to avoid false positives on dates
  
  const tokens = new Set<string>();
  
  // Regex for potential IDs
  const candidates = str.match(/\b[a-zA-Z0-9-]+\b/g) || [];
  
  candidates.forEach(token => {
      const clean = token.replace(/[^a-zA-Z0-9]/g, ''); // Remove hyphens for standardization
      
      // Check if it looks like a year
      const numVal = parseInt(clean);
      if (!isNaN(numVal) && numVal >= 2020 && numVal <= 2030) return; 

      // Condition 1: Pure digits length >= 3
      if (/^\d{3,}$/.test(clean)) {
          tokens.add(clean);
          return;
      }

      // Condition 2: Mixed alphanumeric with significant digits
      // Must have at least 2 digits and some letters
      if (/[a-zA-Z]/.test(clean) && (clean.match(/\d/g) || []).length >= 3) {
          tokens.add(clean);
      }
  });

  return tokens;
};

// Levenshtein distance for typo detection
const levenshteinDistance = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1,   // insertion
            matrix[i - 1][j] + 1    // deletion
          )
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

const getSimilarity = (str1: string, str2: string): number => {
  // 1. Numeric Identity Check (Strongest Signal)
  const nums1 = extractNumericTokens(str1);
  const nums2 = extractNumericTokens(str2);
  
  if (nums1.size > 0 && nums2.size > 0) {
    // Check for intersection
    for (const n1 of nums1) {
        if (nums2.has(n1)) return 0.98; // Very high confidence for matching IDs
    }
  }

  const s1 = normalizeStr(str1);
  const s2 = normalizeStr(str2);
  
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  
  // 2. Token Set Ratio (Jaccard)
  const tokens1 = new Set(s1.split(/\s+/));
  const tokens2 = new Set(s2.split(/\s+/));
  
  let intersectCount = 0;
  tokens1.forEach(t => { if (tokens2.has(t)) intersectCount++; });
  
  const unionSize = new Set([...tokens1, ...tokens2]).size;
  const tokenScore = unionSize > 0 ? intersectCount / unionSize : 0;

  // 3. Containment (e.g. "Tech Corp" in "Tech Corp International")
  const containment = (s1.includes(s2) || s2.includes(s1)) ? 0.85 : 0;

  // 4. Levenshtein (fallback for small strings with typos)
  let levScore = 0;
  if (Math.abs(s1.length - s2.length) < 5 && s1.length > 3) {
      const maxLen = Math.max(s1.length, s2.length);
      const dist = levenshteinDistance(s1, s2);
      levScore = maxLen > 0 ? 1 - (dist / maxLen) : 0;
  }

  return Math.max(tokenScore, containment, levScore);
};

// Recursive subset sum finder with pruning
const findSubsetSum = (
  pool: Transaction[],
  target: number,
  config: typeof DEFAULT_CONFIG,
  depth: number
): Transaction[] | null => {
  if (depth === 0) return null;

  // SORTING OPTIMIZATION: 
  // Sort candidates by amount descending primarily, but if amounts are similar, 
  // logic elsewhere should handle date proximity.
  // Actually, for the recursion, larger items first helps prune the sum tree faster.
  const sortedPool = [...pool].sort((a, b) => b.amount - a.amount);

  const search = (index: number, currentSum: number, currentItems: Transaction[]): Transaction[] | null => {
    const diff = Math.abs(currentSum - target);
    if (diff < config.amountTolerance) return currentItems;
    
    // Pruning conditions
    if (currentItems.length >= depth) return null;
    if (index >= sortedPool.length) return null;
    
    // If current sum already exceeds target significantly, stop this branch
    if (currentSum > target + config.amountTolerance) return null;

    for (let i = index; i < sortedPool.length; i++) {
      const tx = sortedPool[i];
      
      // Look ahead pruning: if adding this item exceeds target, skip it (since we are adding only positive amounts)
      if (currentSum + tx.amount > target + config.amountTolerance) continue;

      const res = search(i + 1, currentSum + tx.amount, [...currentItems, tx]);
      if (res) return res;
    }
    return null;
  };

  return search(0, 0, []);
};

const createAmountIndex = (transactions: Transaction[]) => {
  const index = new Map<number, Transaction[]>();
  for (const t of transactions) {
    const key = Math.round(t.amount * 100);
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(t);
  }
  return index;
};

const getCandidatesFromIndex = (amount: number, index: Map<number, Transaction[]>) => {
  const key = Math.round(amount * 100);
  return [
    ...(index.get(key) || []),
    ...(index.get(key - 1) || []),
    ...(index.get(key + 1) || [])
  ];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const reconcileTransactions = async (
  bankTransactions: Transaction[],
  ledgerTransactions: Transaction[],
  mode: 'speed' | 'accuracy' = 'accuracy',
  onProgress?: (percent: number) => void
): Promise<ReconciliationResult> => {
  
  // Adjust configuration based on mode
  const config = mode === 'accuracy' ? { ...DEFAULT_CONFIG } : {
    ...DEFAULT_CONFIG,
    dateWindowStrict: 1, 
    dateWindowLoose: 3, 
    dateWindowReference: 10,
    fuzzyTextThreshold: 0.85, 
    maxCombinationDepth: 2 
  };

  const matches: MatchGroup[] = [];
  const matchedBankIds = new Set<string>();
  const matchedLedgerIds = new Set<string>();

  const addMatch = (banks: Transaction[], ledgers: Transaction[], type: MatchGroup['type'], reason: string, confidence: number) => {
    matches.push({
      id: `match-${Date.now()}-${matches.length}`,
      bank: banks,
      ledger: ledgers,
      type,
      reason,
      confidence
    });
    banks.forEach(b => matchedBankIds.add(b.id));
    ledgers.forEach(l => matchedLedgerIds.add(l.id));
  };

  if (onProgress) onProgress(5);
  await sleep(10); // Yield to UI

  // Pre-sort transactions by date for easier window lookups
  const sortedBank = [...bankTransactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const sortedLedger = [...ledgerTransactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Build Indexes for O(1) Amount Access
  const ledgerIndex = createAmountIndex(sortedLedger);
  const bankIndex = createAmountIndex(sortedBank); 

  if (onProgress) onProgress(15);
  await sleep(10);

  // =========================================================================================
  // PASS 1: ID Match (Amount + Unique Reference ID) - Highest Confidence
  // =========================================================================================
  // This allows dates to be far apart (e.g. Cheque issued vs Cheque cleared)
  for (const b of sortedBank) {
    if (matchedBankIds.has(b.id)) continue;

    const potentials = getCandidatesFromIndex(b.amount, ledgerIndex);
    const idCandidates = potentials.filter(l => 
      !matchedLedgerIds.has(l.id) &&
      l.type === b.type &&
      getDaysDiff(b.date, l.date) <= config.dateWindowReference
    );

    // Filter specifically for strong ID match
    const strongMatch = idCandidates.find(l => {
        const nums1 = extractNumericTokens(b.description);
        const nums2 = extractNumericTokens(l.description);
        // Intersect
        for(const n of nums1) { if(nums2.has(n)) return true; }
        return false;
    });

    if (strongMatch) {
        addMatch([b], [strongMatch], 'exact', 'Matched by Amount & Reference ID', 0.99);
    }
  }

  if (onProgress) onProgress(30);
  await sleep(10);

  // =========================================================================================
  // PASS 2: Perfect Match (Amount + Exact Date + High Text Sim)
  // =========================================================================================
  for (const b of sortedBank) {
    if (matchedBankIds.has(b.id)) continue;

    const potentials = getCandidatesFromIndex(b.amount, ledgerIndex);
    const perfectCandidates = potentials.filter(l => 
      !matchedLedgerIds.has(l.id) &&
      l.type === b.type &&
      getDaysDiff(b.date, l.date) === 0 // Exact date
    );

    if (perfectCandidates.length > 0) {
       // Sort by text similarity
       perfectCandidates.sort((a, z) => getSimilarity(b.description, z.description) - getSimilarity(b.description, a.description));
       const best = perfectCandidates[0];
       
       // Even if text is different, exact date+amount is usually a match in simple ledgers.
       // But we give higher score if text matches.
       const sim = getSimilarity(b.description, best.description);
       addMatch([b], [best], 'exact', sim > 0.8 ? 'Perfect Match' : 'Matched by Amount & Exact Date', 0.95);
    }
  }

  if (onProgress) onProgress(50);
  await sleep(10);

  // =========================================================================================
  // PASS 3: Strict Window Match (Amount + Nearby Date + Text Check)
  // =========================================================================================
  for (const b of sortedBank) {
    if (matchedBankIds.has(b.id)) continue;

    const potentials = getCandidatesFromIndex(b.amount, ledgerIndex);
    const candidates = potentials.filter(l => 
      !matchedLedgerIds.has(l.id) &&
      l.type === b.type &&
      getDaysDiff(b.date, l.date) <= config.dateWindowStrict
    );

    if (candidates.length === 0) continue;

    // We prioritize Text Similarity first, then Date Closeness
    const scored = candidates.map(c => ({
        tx: c,
        score: getSimilarity(b.description, c.description),
        days: getDaysDiff(b.date, c.date)
    })).sort((a, b) => {
        if (Math.abs(a.score - b.score) > 0.1) return b.score - a.score; // significant text diff
        return a.days - b.days; // otherwise closest date
    });

    const best = scored[0];
    
    // If text similarity is decent OR date is very close (0-1 days), take it
    if (best.score >= 0.5 || best.days <= 1) {
        const reason = best.score >= 0.8 ? 'Strong Text & Nearby Date' : 'Amount & Nearby Date';
        addMatch([b], [best.tx], 'exact', reason, 0.9);
    }
  }

  if (onProgress) onProgress(70);
  await sleep(10);

  // =========================================================================================
  // PASS 4: Fuzzy Text Match (Exact Amount + Loose Date)
  // =========================================================================================
  for (const b of sortedBank) {
    if (matchedBankIds.has(b.id)) continue;

    const potentials = getCandidatesFromIndex(b.amount, ledgerIndex);
    const candidates = potentials.filter(l => 
      !matchedLedgerIds.has(l.id) &&
      l.type === b.type &&
      getDaysDiff(b.date, l.date) <= config.dateWindowLoose
    );

    if (candidates.length === 0) continue;

    const scored = candidates.map(c => {
        const textScore = getSimilarity(b.description, c.description);
        const daysDiff = getDaysDiff(b.date, c.date);
        const penalty = (daysDiff / config.dateWindowLoose) * 0.2; 
        return {
            tx: c,
            rawScore: textScore,
            finalScore: textScore - penalty,
            daysDiff
        };
    }).sort((a, x) => x.finalScore - a.finalScore);

    const best = scored[0];
    if (best.rawScore >= config.fuzzyTextThreshold) {
        addMatch([b], [best.tx], 'fuzzy', `Fuzzy Match (${(best.rawScore * 100).toFixed(0)}% text sim, ${best.daysDiff.toFixed(0)}d offset)`, best.finalScore);
    }
  }

  if (onProgress) onProgress(85);
  await sleep(10);

  // =========================================================================================
  // PASS 5: 1-to-N and N-to-1 (Split/Merge)
  // =========================================================================================
  if (config.maxCombinationDepth > 0) {
    
    // 1-to-N (Split)
    for (const b of sortedBank) {
        if (matchedBankIds.has(b.id)) continue;

        // Get pool of unmatched ledger items of same type within strict date window
        // Optimization: Pre-filter by date closeness to improve chances of finding the "right" combination
        let pool = sortedLedger.filter(l => 
            !matchedLedgerIds.has(l.id) &&
            l.type === b.type && 
            getDaysDiff(b.date, l.date) <= config.dateWindowStrict &&
            l.amount <= b.amount // Item must be smaller than total
        );
        
        // Sort pool by date proximity to bank item to prioritize closer transactions in the subset sum
        pool.sort((x, y) => getDaysDiff(b.date, x.date) - getDaysDiff(b.date, y.date));

        const subset = findSubsetSum(pool, b.amount, config, config.maxCombinationDepth);
        if (subset) {
            addMatch([b], subset, '1-to-N', `Split: 1 Bank Item matches ${subset.length} Ledger Items`, 0.85);
        }
    }

    if (onProgress) onProgress(92);
    await sleep(10);

    // N-to-1 (Merge)
    for (const l of sortedLedger) {
        if (matchedLedgerIds.has(l.id)) continue;

        let pool = sortedBank.filter(b => 
            !matchedBankIds.has(b.id) &&
            b.type === l.type && 
            getDaysDiff(b.date, l.date) <= config.dateWindowStrict &&
            b.amount <= l.amount
        );

        // Sort pool by date proximity
        pool.sort((x, y) => getDaysDiff(l.date, x.date) - getDaysDiff(l.date, y.date));

        const subset = findSubsetSum(pool, l.amount, config, config.maxCombinationDepth);
        if (subset) {
            addMatch(subset, [l], 'N-to-1', `Merge: ${subset.length} Bank Items match 1 Ledger Item`, 0.85);
        }
    }
  }

  if (onProgress) onProgress(100);

  const unmatchedBank = bankTransactions.filter(t => !matchedBankIds.has(t.id));
  const unmatchedLedger = ledgerTransactions.filter(t => !matchedLedgerIds.has(t.id));

  const matchedBankCount = matches.reduce((acc, m) => acc + m.bank.length, 0);
  const matchedLedgerCount = matches.reduce((acc, m) => acc + m.ledger.length, 0);
  const totalItems = bankTransactions.length + ledgerTransactions.length;
  const matchedItems = matchedBankCount + matchedLedgerCount;

  return {
    matches,
    unmatchedBank,
    unmatchedLedger,
    stats: {
      totalBank: bankTransactions.length,
      totalLedger: ledgerTransactions.length,
      matchedBankCount,
      matchedLedgerCount,
      unmatchedBankCount: unmatchedBank.length,
      unmatchedLedgerCount: unmatchedLedger.length,
      matchRate: totalItems > 0 ? (matchedItems / totalItems) * 100 : 0
    }
  };
};