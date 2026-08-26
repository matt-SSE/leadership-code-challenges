import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { WalletTx } from '../src/db/models';
import { createMember, depositAndComplete, getWallet } from './helpers';

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

describe('POST /wallets/:walletId/wagers (A3)', () => {
  it('debits the wallet and writes a ledger entry with no funding transaction', async () => {
    const memberId = await createMember(app, 'wag-happy');
    await depositAndComplete(app, memberId, '50.00');
    const wallet = await getWallet(app, memberId);

    const res = await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '20.00' });

    expect(res.status).toBe(201);
    expect(res.body.balanceAfter).toBe('30.000000000000000000');

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('30.000000000000000000');

    const entries = await WalletTx.findAll({ where: { walletId: wallet.id, type: 'wager' } });
    expect(entries).toHaveLength(1);
    expect(entries[0].transactionId).toBeNull();
    expect(entries[0].amount).toBe('-20.000000000000000000');
  });

  it('allows a wager that exactly exhausts the balance', async () => {
    const memberId = await createMember(app, 'wag-exact');
    await depositAndComplete(app, memberId, '10.00');
    const wallet = await getWallet(app, memberId);

    const res = await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '10.00' });
    expect(res.status).toBe(201);

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('0.000000000000000000');
  });

  it('rejects a wager that would overdraw the wallet, and moves no money', async () => {
    const memberId = await createMember(app, 'wag-insufficient');
    await depositAndComplete(app, memberId, '10.00');
    const wallet = await getWallet(app, memberId);

    const res = await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '10.01' });
    expect(res.status).toBe(422);

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('10.000000000000000000');

    const entries = await WalletTx.findAll({ where: { walletId: wallet.id, type: 'wager' } });
    expect(entries).toHaveLength(0);
  });

  it('rejects a wager against a wallet with a zero balance', async () => {
    const memberId = await createMember(app, 'wag-zero-balance');
    const wallet = await getWallet(app, memberId);

    const res = await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '1.00' });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown wallet', async () => {
    const res = await request(app)
      .post('/wallets/00000000-0000-0000-0000-000000000000/wagers')
      .send({ amount: '1.00' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed walletId', async () => {
    const res = await request(app).post('/wallets/not-a-uuid/wagers').send({ amount: '1.00' });
    expect(res.status).toBe(400);
  });

  it.each([['0'], ['-5'], ['0.00'], ['abc'], ['']])('rejects a non-positive/invalid amount (%s)', async (amount) => {
    const memberId = await createMember(app, 'wag-bad-amount');
    await depositAndComplete(app, memberId, '10.00');
    const wallet = await getWallet(app, memberId);

    const res = await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount });
    expect(res.status).toBe(400);
  });

  it('does not overdraw the wallet under two concurrent wagers', async () => {
    const memberId = await createMember(app, 'wag-concurrent-pair');
    await depositAndComplete(app, memberId, '15.00');
    const wallet = await getWallet(app, memberId);

    const [r1, r2] = await Promise.all([
      request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '10.00' }),
      request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '10.00' }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([201, 422]);

    const walletAfter = await getWallet(app, memberId);
    expect(walletAfter.balance).toBe('5.000000000000000000');

    const entries = await WalletTx.findAll({ where: { walletId: wallet.id, type: 'wager' } });
    expect(entries).toHaveLength(1);
  });
});
