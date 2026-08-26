import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { dec } from '../lib/money';
import { HttpError } from '../lib/httpError';

export async function recordWager(walletId: string, amount: string): Promise<WalletTx> {
  return sequelize.transaction(async (t) => {
    // Row lock on the wallet: serializes concurrent wagers (and any concurrent
    // deposit/withdrawal touching the same wallet) so a debit never reads a
    // balance another in-flight request is also about to spend.
    const wallet = await Wallet.findByPk(walletId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!wallet) {
      throw new HttpError(404, 'wallet not found');
    }

    const wagerAmount = dec(amount);
    const balance = dec(wallet.balance);
    if (balance.isLessThan(wagerAmount)) {
      throw new HttpError(422, 'insufficient balance', { balance: wallet.balance, amount });
    }

    const newBalance = balance.minus(wagerAmount);
    await wallet.update({ balance: newBalance.toFixed() }, { transaction: t });

    // No funding transaction - a wager has no PSP leg.
    return WalletTx.create(
      {
        walletId: wallet.id,
        transactionId: null,
        type: 'wager',
        amount: wagerAmount.negated().toFixed(),
        balanceAfter: newBalance.toFixed(),
      },
      { transaction: t },
    );
  });
}
