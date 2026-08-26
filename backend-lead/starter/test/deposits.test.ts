import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Transaction, WalletTx } from '../src/db/models';
import { createMember, getWallet } from './helpers';

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

async function createDeposit(memberId: string, amount: string, turnoverMultiplier?: number) {
  return request(app)
    .post('/deposits')
    .send({ memberId, amount, ...(turnoverMultiplier === undefined ? {} : { turnoverMultiplier }) });
}

describe('POST /deposits (A1)', () => {
  it('creates a pending funding transaction with a pspRef, no balance change', async () => {
    const memberId = await createMember(app, 'dep-alice');

    const res = await createDeposit(memberId, '100.50', 2);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.pspRef).toBe('string');
    expect(res.body.pspRef.length).toBeGreaterThan(0);

    const tx = await Transaction.findByPk(res.body.id);
    expect(tx?.status).toBe('pending');
    expect(tx?.amount).toBe('100.500000000000000000');
    expect(tx?.turnoverMultiplier).toBe(2);
    expect(tx?.pspRef).toBe(res.body.pspRef);

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('0.000000000000000000');
  });

  it('defaults turnoverMultiplier to 1 when omitted', async () => {
    const memberId = await createMember(app, 'dep-default-tm');
    const res = await createDeposit(memberId, '10.00');
    expect(res.status).toBe(201);

    const tx = await Transaction.findByPk(res.body.id);
    expect(tx?.turnoverMultiplier).toBe(1);
  });

  it('issues a distinct pspRef per deposit', async () => {
    const memberId = await createMember(app, 'dep-distinct-ref');
    const res1 = await createDeposit(memberId, '5.00');
    const res2 = await createDeposit(memberId, '5.00');
    expect(res1.body.pspRef).not.toBe(res2.body.pspRef);
  });

  it.each([['0'], ['-5'], ['0.00'], ['abc'], ['']])('rejects a non-positive/invalid amount (%s)', async (amount) => {
    const memberId = await createMember(app, 'dep-bad-amount');
    const res = await createDeposit(memberId, amount);
    expect(res.status).toBe(400);
  });

  it('rejects a negative or non-integer turnoverMultiplier', async () => {
    const memberId = await createMember(app, 'dep-bad-tm');
    expect((await createDeposit(memberId, '10.00', -1)).status).toBe(400);
    expect((await createDeposit(memberId, '10.00', 1.5)).status).toBe(400);
  });

  it('returns 404 for an unknown member', async () => {
    const res = await createDeposit('00000000-0000-0000-0000-000000000000', '10.00');
    expect(res.status).toBe(404);
  });
});

describe('POST /psp/callbacks (A2)', () => {
  it('returns 404 for an unknown pspRef', async () => {
    const res = await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: 'does-not-exist', status: 'completed', amount: '10.00' });
    expect(res.status).toBe(404);
  });

  it('completes a deposit exactly once: credits the wallet and writes one ledger entry', async () => {
    const memberId = await createMember(app, 'cb-happy');
    const dep = await createDeposit(memberId, '100.50');
    const { pspRef, id: txId } = dep.body;

    const res = await request(app).post('/psp/callbacks').send({ pspRef, status: 'completed', amount: '100.50' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.amountMismatch).toBeUndefined();

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('100.500000000000000000');

    const entries = await WalletTx.findAll({ where: { transactionId: txId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('deposit');
    expect(entries[0].amount).toBe('100.500000000000000000');
    expect(entries[0].balanceAfter).toBe('100.500000000000000000');
  });

  it('marks the transaction failed and moves no money on a failed callback', async () => {
    const memberId = await createMember(app, 'cb-failed');
    const dep = await createDeposit(memberId, '25.00');

    const res = await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: dep.body.pspRef, status: 'failed', amount: '25.00' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('0.000000000000000000');

    const entries = await WalletTx.findAll({ where: { transactionId: dep.body.id } });
    expect(entries).toHaveLength(0);
  });

  it('credits the original deposit amount (not the callback amount) and flags a mismatch', async () => {
    const memberId = await createMember(app, 'cb-mismatch');
    const dep = await createDeposit(memberId, '10.00');

    const res = await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: dep.body.pspRef, status: 'completed', amount: '999.00' });

    expect(res.status).toBe(200);
    expect(res.body.amountMismatch).toBe(true);

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('10.000000000000000000');
  });

  it('does not double-credit on a sequential duplicate callback', async () => {
    const memberId = await createMember(app, 'cb-dup-sequential');
    const dep = await createDeposit(memberId, '40.00');
    const body = { pspRef: dep.body.pspRef, status: 'completed' as const, amount: '40.00' };

    const first = await request(app).post('/psp/callbacks').send(body);
    const second = await request(app).post('/psp/callbacks').send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('40.000000000000000000');

    const entries = await WalletTx.findAll({ where: { transactionId: dep.body.id } });
    expect(entries).toHaveLength(1);
  });

  it('does not double-credit on concurrent duplicate callbacks', async () => {
    const memberId = await createMember(app, 'cb-dup-concurrent');
    const dep = await createDeposit(memberId, '75.25');
    const body = { pspRef: dep.body.pspRef, status: 'completed' as const, amount: '75.25' };

    const [first, second] = await Promise.all([
      request(app).post('/psp/callbacks').send(body),
      request(app).post('/psp/callbacks').send(body),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('75.250000000000000000');

    const entries = await WalletTx.findAll({ where: { transactionId: dep.body.id } });
    expect(entries).toHaveLength(1);
  });

  it('leaves a failed transaction failed if a completed callback arrives afterward', async () => {
    const memberId = await createMember(app, 'cb-failed-then-completed');
    const dep = await createDeposit(memberId, '15.00');
    const { pspRef, id: txId } = dep.body;

    await request(app).post('/psp/callbacks').send({ pspRef, status: 'failed', amount: '15.00' });
    const res = await request(app).post('/psp/callbacks').send({ pspRef, status: 'completed', amount: '15.00' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');

    const tx = await Transaction.findByPk(txId);
    expect(tx?.status).toBe('failed');

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('0.000000000000000000');
  });

  it('rejects a malformed callback body', async () => {
    const res = await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: 'x', status: 'weird', amount: '10.00' });
    expect(res.status).toBe(400);
  });

  it('does not let a callback flip a completed transaction back to failed', async () => {
    const memberId = await createMember(app, 'cb-flap-completed-first');
    const dep = await createDeposit(memberId, '20.00');
    const { pspRef, id: txId } = dep.body;

    await request(app).post('/psp/callbacks').send({ pspRef, status: 'completed', amount: '20.00' });
    const res = await request(app).post('/psp/callbacks').send({ pspRef, status: 'failed', amount: '20.00' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');

    const tx = await Transaction.findByPk(txId);
    expect(tx?.status).toBe('completed');

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('20.000000000000000000');

    const entries = await WalletTx.findAll({ where: { transactionId: txId } });
    expect(entries).toHaveLength(1);
  });

  it("handles two of the same member's deposits completing concurrently without lost updates", async () => {
    const memberId = await createMember(app, 'cb-two-deposits-concurrent');
    const depA = await createDeposit(memberId, '30.00');
    const depB = await createDeposit(memberId, '45.50');

    const [resA, resB] = await Promise.all([
      request(app).post('/psp/callbacks').send({ pspRef: depA.body.pspRef, status: 'completed', amount: '30.00' }),
      request(app).post('/psp/callbacks').send({ pspRef: depB.body.pspRef, status: 'completed', amount: '45.50' }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const walletRes = await getWallet(app, memberId);
    expect(walletRes.balance).toBe('75.500000000000000000');

    const entriesA = await WalletTx.findAll({ where: { transactionId: depA.body.id } });
    const entriesB = await WalletTx.findAll({ where: { transactionId: depB.body.id } });
    expect(entriesA).toHaveLength(1);
    expect(entriesB).toHaveLength(1);
  });
});
