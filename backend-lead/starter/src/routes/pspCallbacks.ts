import { Router } from 'express';
import { z } from 'zod';
import * as depositService from '../services/depositService';
import { decimalString } from '../lib/validation';

export const pspCallbacksRouter = Router();

const callbackBody = z.object({
  pspRef: z.string().min(1).max(200),
  status: z.enum(['completed', 'failed']),
  amount: decimalString,
});

pspCallbacksRouter.post('/', async (req, res, next) => {
  try {
    const body = callbackBody.parse(req.body);
    const result = await depositService.handlePspCallback(body.pspRef, body.status, body.amount);

    if (result.kind === 'unknown') {
      res.status(404).json({ error: 'unknown pspRef' });
      return;
    }

    res.status(200).json({
      id: result.transaction.id,
      status: result.transaction.status,
      ...(result.kind === 'completed' && result.amountMismatch ? { amountMismatch: true } : {}),
    });
  } catch (err) {
    next(err);
  }
});
