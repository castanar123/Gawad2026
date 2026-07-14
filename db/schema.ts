import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const remoteCameraSessions = sqliteTable("remote_camera_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  offer: text("offer"),
  answer: text("answer"),
  status: text("status").notNull().default("waiting"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
