import { DataTypes, Model, Sequelize } from 'sequelize';

export type WalletTxType = 'deposit' | 'withdrawal' | 'wager';

// Append-only ledger row. Never update or destroy an existing row - only ever create new ones.
export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare transactionId: string | null;
  declare type: WalletTxType;
  // Signed: positive credits the wallet, negative debits it. See migration comment.
  declare amount: string;
  declare balanceAfter: string;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      transactionId: { type: DataTypes.UUID, allowNull: true },
      type: { type: DataTypes.STRING, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
    },
    { sequelize, tableName: 'wallet_txs', underscored: true, updatedAt: false },
  );
}
