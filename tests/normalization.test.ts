import { describe, expect, it } from "vitest";

import { normalizeLeadPayload, normalizePhone } from "../src/utils/normalization.js";

describe("normalizeLeadPayload", () => {
  it("normalizes common lead fields", () => {
    const lead = normalizeLeadPayload({
      fullName: "  John   Doe ",
      email: " John@Example.COM ",
      phone: "(555) 010-1234",
      message: "Need help with sales automation"
    });

    expect(lead).toEqual({
      name: "John Doe",
      email: "john@example.com",
      phone: "+15550101234",
      source: "unknown",
      inquiryText: "Need help with sales automation",
      companyDomain: "example.com"
    });
  });

  it("rejects leads without a contact method", () => {
    expect(() =>
      normalizeLeadPayload({
        name: "No Contact",
        message: "Hello"
      })
    ).toThrow(/contact method/i);
  });
});

describe("normalizePhone", () => {
  it("returns null for clearly invalid numbers", () => {
    expect(normalizePhone("123")).toBeNull();
  });
});
