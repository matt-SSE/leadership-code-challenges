import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { Transaction, initTransaction } from './transaction';
import { WalletTx, initWalletTx } from './walletTx';

initMember(sequelize);
initWallet(sequelize);
initTransaction(sequelize);
initWalletTx(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Member.hasMany(Transaction, { foreignKey: 'memberId', as: 'transactions' });
Transaction.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'ledgerEntries' });
WalletTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

// Nullable: a wager's ledger entry has no funding transaction.
Transaction.hasOne(WalletTx, { foreignKey: 'transactionId', as: 'ledgerEntry' });
WalletTx.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

export { Member, Wallet, Transaction, WalletTx };
