// Rule 3: derived from the claim id, so a retry of a claim reuses the same batch id.
export function senderBatchIdForClaim(claimId: string): string {
  return `leslie-claim-${claimId}`;
}
