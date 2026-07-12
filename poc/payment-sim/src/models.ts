// models.ts - MySQL final ledger schema (Sequelize)
import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { config } from "./config";

export class Account extends Model<InferAttributes<Account>, InferCreationAttributes<Account>> {
  declare id: string;
  declare name: string;
  declare balance: string; // DECIMAL(18,2) — mysql2 returns decimals as strings
  declare openingBalance: CreationOptional<string>; // seed value, kept for reconciliation
}

export class Payment extends Model<InferAttributes<Payment>, InferCreationAttributes<Payment>> {
  declare id: CreationOptional<number>;
  declare reference: string;
  declare payerId: string;
  declare payeeId: string;
  declare currency: string;
  declare principal: string;
  declare feeTotal: string;
  declare grandTotal: string;
  declare status: "awaiting_settlement" | "settled";
  declare settledAt: CreationOptional<Date | null>;
}

export class PaymentItem extends Model<InferAttributes<PaymentItem>, InferCreationAttributes<PaymentItem>> {
  declare id: CreationOptional<number>;
  declare paymentId: number;
  declare kind: "principal" | "fee_processing" | "fee_platform" | "fee_vat";
  declare description: string;
  declare amount: string;
  declare beneficiaryId: string;
}

export class ProcessedEvent extends Model<InferAttributes<ProcessedEvent>, InferCreationAttributes<ProcessedEvent>> {
  declare eventId: string;
}

export function createDb(): Sequelize {
  const sequelize = new Sequelize({
    dialect: "mysql",
    host: config.mysql.host,
    port: config.mysql.port,
    username: config.mysql.username,
    password: config.mysql.password,
    database: config.mysql.database,
    logging: false,
    pool: { max: 30, min: 0, acquire: 60000, idle: 10000 },
    define: { timestamps: true, underscored: true },
  });

  Account.init(
    {
      id: { type: DataTypes.STRING(64), primaryKey: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: "0.00" },
      openingBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: "0.00" },
    },
    { sequelize, tableName: "accounts" }
  );

  Payment.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      payerId: { type: DataTypes.STRING(64), allowNull: false },
      payeeId: { type: DataTypes.STRING(64), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      principal: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
      feeTotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
      grandTotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
      status: { type: DataTypes.ENUM("awaiting_settlement", "settled"), allowNull: false },
      settledAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    },
    { sequelize, tableName: "payments" }
  );

  PaymentItem.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      paymentId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "payments", key: "id" },
      },
      kind: {
        type: DataTypes.ENUM("principal", "fee_processing", "fee_platform", "fee_vat"),
        allowNull: false,
      },
      description: { type: DataTypes.STRING(255), allowNull: false },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
      beneficiaryId: { type: DataTypes.STRING(64), allowNull: false },
    },
    { sequelize, tableName: "payment_items" }
  );

  ProcessedEvent.init(
    { eventId: { type: DataTypes.STRING(128), primaryKey: true } },
    { sequelize, tableName: "processed_events" }
  );

  Payment.hasMany(PaymentItem, { foreignKey: "paymentId", as: "items" });
  PaymentItem.belongsTo(Payment, { foreignKey: "paymentId", as: "payment" });

  return sequelize;
}
