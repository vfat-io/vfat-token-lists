import { PROBE_RECIPIENT } from './probe-contract.mjs';

// https://github.com/aave-dao/aave-address-book/blob/main/src/ts/AaveV3Polygon.ts
const POLYGON_POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const RAY = 10n ** 27n;
const SELECTORS = {
  underlyingAsset: '0xb16a19de', // UNDERLYING_ASSET_ADDRESS()
  reserveAToken: '0xcff027d9', // getReserveAToken(address)
  normalizedIncome: '0xd15e0053', // getReserveNormalizedIncome(address)
  scaledBalance: '0x1da24f3e', // scaledBalanceOf(address)
};

export const AAVE_COLLATERAL_ERRORS = new Map([
  ['0x6679996d', 'HealthFactorLowerThanLiquidationThreshold()'],
  ['0x5b263df7', 'LtvValidationFailed()'],
]);

function addressWord(address) {
  return address.slice(2).padStart(64, '0');
}

async function callWord(rpc, to, data, block) {
  const result = await rpc('eth_call', [{ to, data }, block]);
  if (!/^0x[0-9a-f]{64}$/i.test(result)) {
    throw new Error('expected one ABI word');
  }
  return result.toLowerCase();
}

export async function polygonAaveReserve(rpc, token, block) {
  try {
    if (BigInt(await rpc('eth_chainId', [])) !== 137n) {
      return null;
    }
    const underlyingWord = await callWord(rpc, token, SELECTORS.underlyingAsset, block);
    if (!underlyingWord.startsWith('0x000000000000000000000000')) {
      return null;
    }
    const registeredAToken = await callWord(rpc, POLYGON_POOL, SELECTORS.reserveAToken + underlyingWord.slice(2), block);
    return registeredAToken === '0x' + addressWord(token) ? underlyingWord : null;
  } catch {
    return null;
  }
}

export async function matchesAaveRounding(rpc, token, reserveWord, holder, amount, actual, block) {
  try {
    const income = await callWord(rpc, POLYGON_POOL, SELECTORS.normalizedIncome + reserveWord.slice(2), block);
    const index = BigInt(income);
    if (index < RAY) {
      return false;
    }
    const scaledBalance = async (account) =>
      BigInt(await callWord(rpc, token, SELECTORS.scaledBalance + addressWord(account), block));
    const holderBefore = await scaledBalance(holder);
    const recipientBefore = await scaledBalance(PROBE_RECIPIENT);

    // Aave V3 uses ceil for scaled transfers and floor for displayed balances.
    // The probe sends the measured recipient increase back to the original holder.
    const balance = (scaled) => scaled * index / RAY;
    const scaledAmount = (raw) => (raw * RAY + index - 1n) / index;
    const sent = scaledAmount(amount);
    if (sent > holderBefore) {
      return false;
    }
    const spent = balance(holderBefore) - balance(holderBefore - sent);
    const received = balance(recipientBefore + sent) - balance(recipientBefore);
    const sentBack = scaledAmount(received);
    if (sentBack > recipientBefore + sent) {
      return false;
    }
    const returned = balance(holderBefore - sent + sentBack) - balance(holderBefore - sent);
    const spentReturning = balance(recipientBefore + sent) - balance(recipientBefore + sent - sentBack);
    return actual.received === received && actual.spent === spent &&
      actual.returned === returned && actual.spentReturning === spentReturning;
  } catch {
    return false;
  }
}
