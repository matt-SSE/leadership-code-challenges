import { z } from 'zod';

// DECIMAL(36,18) fits in 37 chars (36 digits + 1 dot); 40 leaves a small margin
// while still rejecting absurdly oversized payloads before they touch the DB.
const decimalStringSchema = z.string().max(40, 'amount is too long').regex(/^\d+(\.\d+)?$/, 'amount must be a decimal string');

export const decimalString = decimalStringSchema;

export const positiveDecimalString = decimalStringSchema.refine(
  (v) => !/^0(\.0*)?$/.test(v),
  'amount must be positive',
);
