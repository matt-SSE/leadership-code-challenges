import { DataTypes, Model, Sequelize } from 'sequelize';

export type TransactionType = 'deposit' | 'withdrawal';
export type TransactionStatus = 'pending' | 'completed' | 'failed';

export class Transaction extends Model {
  declare id: string;
  declare memberId: string;
  declare type: TransactionType;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare amount: string;
  declare turnoverMultiplier: number;
  declare pspRef: string | null;
  declare status: TransactionStatus;
}

export function initTransaction(sequelize: Sequelize): void {
  Transaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      pspRef: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    },
    { sequelize, tableName: 'transactions', underscored: true },
  );
}
