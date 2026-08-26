import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from '../services/withdrawalService';
import { positiveDecimalString } from '../lib/validation';

export const withdrawalsRouter = Router();

const createWithdrawalBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveDecimalString,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBody.parse(req.body);
    const tx = await withdrawalService.createWithdrawal(body.memberId, body.amount);
    res.status(201).json({ id: tx.id, status: tx.status, amount: tx.amount });
  } catch (err) {
    next(err);
  }
});
