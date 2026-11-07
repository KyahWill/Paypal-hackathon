import type { PrismaClient } from "@/app/generated/prisma/client";

// Wipes every application table. Uses TRUNCATE because the AuditLog trigger
// rejects row deletes.
export async function truncateAllTables(db: PrismaClient) {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${names} CASCADE`);
}
