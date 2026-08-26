import crypto from 'crypto';
import { sequelize } from '../db/sequelize';
import { Member, Wallet, Transaction, WalletTx } from '../db/models';
import { dec } from '../lib/money';
import { HttpError } from '../lib/httpError';

export async function createDeposit(
  memberId: string,
  amount: string,
  turnoverMultiplier: number,
): Promise<Transaction> {
  return sequelize.transaction(async (t) => {
    const member = await Member.findByPk(memberId, { transaction: t });
    if (!member) {
      throw new HttpError(404, 'member not found');
    }

    // Opaque, unguessable reference the mock PSP echoes back in its callback.
    // It's the idempotency key for A2, so it must be unique - the DB enforces
    // that with a unique index; a collision here would raise on insert.
    const pspRef = crypto.randomUUID();

    return Transaction.create(
      {
        memberId,
        type: 'deposit',
        amount,
        turnoverMultiplier,
        pspRef,
        status: 'pending',
      },
      { transaction: t },
    );
  });
}

export type PspCallbackResult =
  | { kind: 'unknown' }
  | { kind: 'already_processed'; transaction: Transaction }
  | { kind: 'failed'; transaction: Transaction }
  | { kind: 'completed'; transaction: Transaction; amountMismatch: boolean };

export async function handlePspCallback(
  pspRef: string,
  status: 'completed' | 'failed',
  amount: string,
): Promise<PspCallbackResult> {
  return sequelize.transaction(async (t) => {
    // Row lock on the transaction: two concurrent deliveries of the same
    // callback serialize here - the second waits for the first's commit and
    // then sees status !== 'pending', so it takes the idempotent branch below.
    const tx = await Transaction.findOne({
      where: { pspRef },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!tx) {
      return { kind: 'unknown' };
    }

    if (tx.status !== 'pending') {
      // Replay of a callback we already applied (or a late callback for a
      // transaction already resolved another way). No balance change.
      return { kind: 'already_processed', transaction: tx };
    }

    if (status === 'failed') {
      await tx.update({ status: 'failed' }, { transaction: t });
      return { kind: 'failed', transaction: tx };
    }

    // status === 'completed'
    const originalAmount = dec(tx.amount);
    const callbackAmount = dec(amount);
    const amountMismatch = !callbackAmount.isEqualTo(originalAmount);
    if (amountMismatch) {
      // The callback amount is untrusted PSP input, not a source of truth for
      // our books - we credit the amount our own system recorded (and already
      // returned to the client) at deposit time, and only surface the
      // mismatch for a human to investigate. Silently trusting whatever
      // figure the webhook sends would let a compromised/misbehaving PSP
      // dictate how much we credit.
      // eslint-disable-next-line no-console
      console.warn(
        `psp callback amount mismatch: tx=${tx.id} pspRef=${pspRef} originalAmount=${tx.amount} callbackAmount=${amount}`,
      );
    }

    await tx.update({ status: 'completed' }, { transaction: t });

    // Row lock on the wallet: serializes concurrent balance mutations
    // (this callback, a concurrent wager, etc.) against the same wallet.
    const wallet = await Wallet.findOne({
      where: { memberId: tx.memberId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!wallet) {
      // Data-integrity invariant, not a client error: every member has a
      // wallet from the moment they're created.
      throw new Error(`wallet missing for member ${tx.memberId}`);
    }

    const newBalance = dec(wallet.balance).plus(originalAmount);
    await wallet.update({ balance: newBalance.toFixed() }, { transaction: t });

    await WalletTx.create(
      {
        walletId: wallet.id,
        transactionId: tx.id,
        type: 'deposit',
        amount: originalAmount.toFixed(),
        balanceAfter: newBalance.toFixed(),
      },
      { transaction: t },
    );

    return { kind: 'completed', transaction: tx, amountMismatch };
  });
}
