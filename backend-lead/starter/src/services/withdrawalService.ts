import { sequelize } from '../db/sequelize';
import { Member, Wallet, Transaction, WalletTx } from '../db/models';
import { dec, ZERO } from '../lib/money';
import { HttpError } from '../lib/httpError';

export async function createWithdrawal(memberId: string, amount: string): Promise<Transaction> {
  return sequelize.transaction(async (t) => {
    const member = await Member.findByPk(memberId, { transaction: t });
    if (!member) {
      throw new HttpError(404, 'member not found');
    }

    // Row lock on the wallet: serializes concurrent withdrawals/wagers against
    // this member's balance.
    const wallet = await Wallet.findOne({ where: { memberId }, lock: t.LOCK.UPDATE, transaction: t });
    if (!wallet) {
      throw new Error(`wallet missing for member ${memberId}`);
    }

    // Required turnover = sum(deposit.amount * deposit.turnoverMultiplier) over
    // this member's COMPLETED deposits only - pending/failed deposits impose
    // no requirement. Accrued turnover = sum of all wager amounts on this
    // wallet. Both are read inside this transaction, after the wallet lock,
    // so a concurrent withdrawal sees a consistent, already-serialized view.
    const completedDeposits = await Transaction.findAll({
      where: { memberId, type: 'deposit', status: 'completed' },
      transaction: t,
    });
    const requiredTurnover = completedDeposits.reduce(
      (sum, deposit) => sum.plus(dec(deposit.amount).multipliedBy(deposit.turnoverMultiplier)),
      ZERO,
    );

    const wagers = await WalletTx.findAll({ where: { walletId: wallet.id, type: 'wager' }, transaction: t });
    const accruedTurnover = wagers.reduce((sum, wager) => sum.plus(dec(wager.amount).abs()), ZERO);

    if (accruedTurnover.isLessThan(requiredTurnover)) {
      // toFixed(18) to match the DECIMAL(36,18) string shape everywhere else
      // in the API - these figures are computed in JS, not read back from a
      // DECIMAL column, so BigNumber won't pad them on its own.
      throw new HttpError(422, 'turnover requirement not met', {
        requiredTurnover: requiredTurnover.toFixed(18),
        accruedTurnover: accruedTurnover.toFixed(18),
        outstandingTurnover: requiredTurnover.minus(accruedTurnover).toFixed(18),
      });
    }

    const withdrawalAmount = dec(amount);
    const balance = dec(wallet.balance);
    if (balance.isLessThan(withdrawalAmount)) {
      throw new HttpError(422, 'insufficient balance', { balance: wallet.balance, amount });
    }

    const newBalance = balance.minus(withdrawalAmount);
    await wallet.update({ balance: newBalance.toFixed() }, { transaction: t });

    // Funding transaction starts Pending - a human approves the actual payout later.
    const tx = await Transaction.create(
      { memberId, type: 'withdrawal', amount: withdrawalAmount.toFixed(), status: 'pending' },
      { transaction: t },
    );

    await WalletTx.create(
      {
        walletId: wallet.id,
        transactionId: tx.id,
        type: 'withdrawal',
        amount: withdrawalAmount.negated().toFixed(),
        balanceAfter: newBalance.toFixed(),
      },
      { transaction: t },
    );

    return tx;
  });
}
