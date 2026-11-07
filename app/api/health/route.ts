import { connection } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  // Must run per request: a prerendered "ok" would say nothing about the database.
  await connection();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" });
  } catch (error) {
    // The name only, so connection details can never reach the logs.
    console.error("Health check failed:", error instanceof Error ? error.name : "unknown");
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
