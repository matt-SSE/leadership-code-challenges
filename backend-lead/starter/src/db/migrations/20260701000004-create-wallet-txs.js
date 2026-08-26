'use strict';

// `wallet_txs` is the append-only ledger: the source of truth for a wallet's
// balance. The app must only ever INSERT here, never UPDATE/DELETE - there is
// intentionally no `updated_at` column to make that convention visible in the schema.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      // Null for wagers - a wager has no PSP/funding leg, only a balance movement.
      transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
      },
      type: { type: Sequelize.STRING, allowNull: false },
      // Signed: +amount credits the wallet (deposit), -amount debits it
      // (withdrawal, wager). Reconstruction is then a plain SUM(amount) per
      // wallet, with no per-type branching needed.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      // Denormalized snapshot of the running balance right after this entry,
      // for fast reads/audits. Not the source of truth - SUM(amount) is.
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('wallet_txs', ['wallet_id', 'created_at']);
    await queryInterface.addIndex('wallet_txs', ['transaction_id']);

    await queryInterface.addConstraint('wallet_txs', {
      type: 'check',
      fields: ['type'],
      name: 'wallet_txs_type_check',
      where: { type: { [Sequelize.Op.in]: ['deposit', 'withdrawal', 'wager'] } },
    });
    await queryInterface.addConstraint('wallet_txs', {
      type: 'check',
      fields: ['amount'],
      name: 'wallet_txs_amount_nonzero_check',
      where: { amount: { [Sequelize.Op.ne]: 0 } },
    });
    // Wagers never carry a funding transaction; deposits/withdrawals always do.
    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs ADD CONSTRAINT wallet_txs_transaction_id_by_type_check
      CHECK (
        (type = 'wager' AND transaction_id IS NULL) OR
        (type <> 'wager' AND transaction_id IS NOT NULL)
      )
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wallet_txs');
  },
};
