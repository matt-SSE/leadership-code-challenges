'use strict';

// `transactions` = funding transactions only (deposit / withdrawal). Wagers never
// appear here - they have no PSP leg, they only ever produce a `wallet_txs` row.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
      },
      type: { type: Sequelize.STRING, allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      psp_ref: { type: Sequelize.STRING, allowNull: true },
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'pending' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('transactions', ['member_id']);
    await queryInterface.addIndex('transactions', ['status']);

    // Idempotency key for PSP callbacks. Partial (NULLs excluded) so multiple
    // withdrawals - which don't get a pspRef until a payout is initiated - don't collide.
    await queryInterface.addIndex('transactions', ['psp_ref'], {
      name: 'transactions_psp_ref_unique',
      unique: true,
      where: { psp_ref: { [Sequelize.Op.ne]: null } },
    });

    await queryInterface.addConstraint('transactions', {
      type: 'check',
      fields: ['type'],
      name: 'transactions_type_check',
      where: { type: { [Sequelize.Op.in]: ['deposit', 'withdrawal'] } },
    });
    await queryInterface.addConstraint('transactions', {
      type: 'check',
      fields: ['status'],
      name: 'transactions_status_check',
      where: { status: { [Sequelize.Op.in]: ['pending', 'completed', 'failed'] } },
    });
    await queryInterface.addConstraint('transactions', {
      type: 'check',
      fields: ['amount'],
      name: 'transactions_amount_positive_check',
      where: { amount: { [Sequelize.Op.gt]: 0 } },
    });
    await queryInterface.addConstraint('transactions', {
      type: 'check',
      fields: ['turnover_multiplier'],
      name: 'transactions_turnover_multiplier_check',
      where: { turnover_multiplier: { [Sequelize.Op.gte]: 0 } },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('transactions');
  },
};
