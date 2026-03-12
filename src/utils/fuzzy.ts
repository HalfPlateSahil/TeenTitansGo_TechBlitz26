import { normalizeName } from "./normalization.js";

import type { DuplicateMatch, LeadRecord, NormalizedLeadInput } from "../types/lead.js";

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));

  for (let row = 0; row <= left.length; row += 1) {
    matrix[row][0] = row;
  }

  for (let column = 0; column <= right.length; column += 1) {
    matrix[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function similarityScore(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 1;
  }

  return 1 - levenshteinDistance(left, right) / maxLength;
}

export function scoreDuplicateLead(input: NormalizedLeadInput, existingLead: LeadRecord): DuplicateMatch | null {
  const reasons: string[] = [];
  let confidence = 0;

  if (input.email && existingLead.normalizedEmail && input.email === existingLead.normalizedEmail) {
    confidence = 1;
    reasons.push("Exact email match");
  }

  if (input.phone && existingLead.normalizedPhone && input.phone === existingLead.normalizedPhone) {
    confidence = Math.max(confidence, 0.97);
    reasons.push("Exact phone match");
  }

  const nameScore = similarityScore(normalizeName(input.name), existingLead.normalizedName);
  if (nameScore >= 0.92) {
    confidence = Math.max(confidence, 0.74 + nameScore * 0.18);
    reasons.push(`Highly similar name (${nameScore.toFixed(2)})`);
  }

  if (input.companyDomain && existingLead.companyDomain && input.companyDomain === existingLead.companyDomain) {
    confidence = Math.max(confidence, Math.min(0.95, confidence + 0.08));
    reasons.push("Matching company domain");
  }

  if (confidence < 0.65) {
    return null;
  }

  return {
    existingLeadId: existingLead.id,
    confidence: Number(confidence.toFixed(2)),
    reasons
  };
}
