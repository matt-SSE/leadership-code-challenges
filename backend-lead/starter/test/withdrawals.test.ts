import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Transaction, WalletTx } from '../src/db/models';
import { createMember, depositAndComplete, getWallet, wager } from './helpers';

const app = createApp();

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe('POST /withdrawals (A4)', () => {
  it('blocks a withdrawal when turnover has not been met and reports how much is outstanding', async () => {
    const memberId = await createMember(app, 'wd-locked');
    await depositAndComplete(app, memberId, '100.00', 2); // requires 200 turnover
    const wallet = await getWallet(app, memberId);
    await wager(app, wallet.id, '50.00'); // accrued 50 - still 150 short

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '10.00' });

    expect(res.status).toBe(422);
    expect(res.body.requiredTurnover).toBe('200.000000000000000000');
    expect(res.body.accruedTurnover).toBe('50.000000000000000000');
    expect(res.body.outstandingTurnover).toBe('150.000000000000000000');

    // no money moved
    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('50.000000000000000000');
    const txCount = await Transaction.count({ where: { memberId, type: 'withdrawal' } });
    expect(txCount).toBe(0);
  });

  it('unblocks a withdrawal once accrued turnover meets the requirement', async () => {
    const memberId = await createMember(app, 'wd-unlocked');
    await depositAndComplete(app, memberId, '50.00', 1); // requires 50 turnover
    await depositAndComplete(app, memberId, '100.00', 0); // extra balance, no extra requirement
    const wallet = await getWallet(app, memberId);
    await wager(app, wallet.id, '50.00'); // accrued exactly meets the 50 requirement

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '30.00' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.amount).toBe('30.000000000000000000');

    const tx = await Transaction.findByPk(res.body.id);
    expect(tx?.type).toBe('withdrawal');
    expect(tx?.status).toBe('pending');

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('70.000000000000000000'); // 150 - 50 wagered - 30 withdrawn

    const entries = await WalletTx.findAll({ where: { transactionId: res.body.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('withdrawal');
    expect(entries[0].amount).toBe('-30.000000000000000000');
  });

  it('a zero turnoverMultiplier deposit never locks withdrawals', async () => {
    const memberId = await createMember(app, 'wd-zero-multiplier');
    await depositAndComplete(app, memberId, '80.00', 0);

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '20.00' });

    expect(res.status).toBe(201);
    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('60.000000000000000000');
  });

  it('ignores a still-pending deposit when computing the turnover requirement', async () => {
    const memberId = await createMember(app, 'wd-pending-deposit-excluded');
    await depositAndComplete(app, memberId, '50.00', 0); // completed, no requirement, funds the balance

    const depRes = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '20.00', turnoverMultiplier: 5 }); // left pending on purpose
    expect(depRes.status).toBe(201);

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '10.00' });
    expect(res.status).toBe(201);
  });

  it('ignores a failed deposit when computing the turnover requirement', async () => {
    const memberId = await createMember(app, 'wd-failed-deposit-excluded');
    await depositAndComplete(app, memberId, '50.00', 0);

    const depRes = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '20.00', turnoverMultiplier: 5 });
    await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: depRes.body.pspRef, status: 'failed', amount: '20.00' });

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '10.00' });
    expect(res.status).toBe(201);
  });

  it('rejects a withdrawal that exceeds the wallet balance even when turnover is met', async () => {
    const memberId = await createMember(app, 'wd-insufficient-balance');
    await depositAndComplete(app, memberId, '20.00', 0); // no turnover lock, balance 20

    const res = await request(app).post('/withdrawals').send({ memberId, amount: '50.00' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient balance');

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('20.000000000000000000');
  });

  it('returns 404 for an unknown member', async () => {
    const res = await request(app)
      .post('/withdrawals')
      .send({ memberId: '00000000-0000-0000-0000-000000000000', amount: '10.00' });
    expect(res.status).toBe(404);
  });

  it.each([['0'], ['-5'], ['abc'], ['']])('rejects a non-positive/invalid amount (%s)', async (amount) => {
    const memberId = await createMember(app, 'wd-bad-amount');
    await depositAndComplete(app, memberId, '10.00', 0);
    const res = await request(app).post('/withdrawals').send({ memberId, amount });
    expect(res.status).toBe(400);
  });

  it('does not let two concurrent withdrawals overdraw the wallet', async () => {
    const memberId = await createMember(app, 'wd-concurrent');
    await depositAndComplete(app, memberId, '100.00', 0); // no turnover lock, balance 100

    const [r1, r2] = await Promise.all([
      request(app).post('/withdrawals').send({ memberId, amount: '60.00' }),
      request(app).post('/withdrawals').send({ memberId, amount: '60.00' }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([201, 422]);

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('40.000000000000000000');

    const txCount = await Transaction.count({ where: { memberId, type: 'withdrawal', status: 'pending' } });
    expect(txCount).toBe(1);
  });
});
