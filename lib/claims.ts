import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  AuditActor,
  ClaimState,
  type VerdictCode,
} from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/db";

const ALLOWED_TRANSITIONS: Record<ClaimState, ClaimState[]> = {
  SUBMITTED: [ClaimState.VERIFYING],
  VERIFYING: [ClaimState.APPROVED, ClaimState.REJECTED, ClaimState.ESCALATED],
  APPROVED: [ClaimState.PAYING],
  PAYING: [ClaimState.PAID, ClaimState.ESCALATED],
  ESCALATED: [ClaimState.APPROVED, ClaimState.REJECTED],
  PAID: [],
  REJECTED: [],
};

type Transition = {
  claimId: string;
  from: ClaimState;
  to: ClaimState;
  actor: AuditActor;
  actorUserId?: string;
  verdictCode?: VerdictCode;
  note?: string;
};

// The only way a claim changes state, so rule 4 cannot be forgotten. It takes a
// transaction client because the state and its audit row must commit together.
export async function transitionClaim(tx: Prisma.TransactionClient, transition: Transition) {
  const { claimId, from, to, actor, actorUserId, verdictCode, note } = transition;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Claim ${claimId}: ${from} -> ${to} is not allowed`);
  }

  // Filtering on the old state means two racing callers cannot both succeed.
  const { count } = await tx.claim.updateMany({
    where: { id: claimId, state: from },
    data: { state: to, ...(verdictCode ? { verdictCode } : {}) },
  });
  if (count !== 1) throw new Error(`Claim ${claimId} is not in state ${from}`);

  await tx.auditLog.create({
    data: { claimId, actor, actorUserId, fromState: from, toState: to, verdictCode, note },
  });
}

export async function createClaim(args: {
  projectId: string;
  submittedById: string;
  image: Buffer;
  mimeType: string;
}) {
  const { projectId, submittedById, image, mimeType } = args;
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { currency: true },
    });
    const claim = await tx.claim.create({
      data: {
        projectId,
        submittedById,
        currency: project.currency,
        receipt: {
          create: {
            imageData: new Uint8Array(image),
            mimeType,
            sha256: createHash("sha256").update(image).digest("hex"),
          },
        },
      },
    });
    await tx.auditLog.create({
      data: {
        claimId: claim.id,
        actor: AuditActor.USER,
        actorUserId: submittedById,
        toState: ClaimState.SUBMITTED,
      },
    });
    return claim;
  });
}
