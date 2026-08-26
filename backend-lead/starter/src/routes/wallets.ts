import { Router } from 'express';
import { z } from 'zod';
import * as wagerService from '../services/wagerService';
import { positiveDecimalString } from '../lib/validation';

export const walletsRouter = Router();

const walletIdParams = z.object({ walletId: z.string().uuid() });
const createWagerBody = z.object({ amount: positiveDecimalString });

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const { walletId } = walletIdParams.parse(req.params);
    const body = createWagerBody.parse(req.body);
    const entry = await wagerService.recordWager(walletId, body.amount);
    res.status(201).json({
      id: entry.id,
      walletId: entry.walletId,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
    });
  } catch (err) {
    next(err);
  }
});
