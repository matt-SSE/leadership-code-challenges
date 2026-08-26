import request from 'supertest';
import { Express } from 'express';

export async function createMember(app: Express, username: string): Promise<string> {
  const res = await request(app).post('/members').send({ username });
  if (res.status !== 201) throw new Error(`member create failed: ${JSON.stringify(res.body)}`);
  return res.body.member.id as string;
}

export async function getWallet(app: Express, memberId: string): Promise<{ id: string; balance: string }> {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  if (res.status !== 200) throw new Error(`wallet fetch failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// Drives the real A1 -> A2 flow so tests build state through the actual
// endpoints instead of writing rows directly.
export async function depositAndComplete(
  app: Express,
  memberId: string,
  amount: string,
  turnoverMultiplier?: number,
): Promise<{ transactionId: string; pspRef: string }> {
  const depRes = await request(app)
    .post('/deposits')
    .send({ memberId, amount, ...(turnoverMultiplier === undefined ? {} : { turnoverMultiplier }) });
  if (depRes.status !== 201) throw new Error(`deposit create failed: ${JSON.stringify(depRes.body)}`);
  const { id: transactionId, pspRef } = depRes.body;

  const cbRes = await request(app).post('/psp/callbacks').send({ pspRef, status: 'completed', amount });
  if (cbRes.status !== 200 || cbRes.body.status !== 'completed') {
    throw new Error(`deposit completion failed: ${JSON.stringify(cbRes.body)}`);
  }
  return { transactionId, pspRef };
}

export async function wager(app: Express, walletId: string, amount: string): Promise<{ balanceAfter: string }> {
  const res = await request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
  if (res.status !== 201) throw new Error(`wager failed: ${JSON.stringify(res.body)}`);
  return res.body;
}
