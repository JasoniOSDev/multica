import { describe, expect, it } from "vitest";
import { deriveMergeRequestStatusKind } from "./merge-request-status";

describe("deriveMergeRequestStatusKind", () => {
  it("maps each known GitLab state to its kind", () => {
    expect(deriveMergeRequestStatusKind("opened")).toBe("open");
    expect(deriveMergeRequestStatusKind("merged")).toBe("merged");
    expect(deriveMergeRequestStatusKind("closed")).toBe("closed");
    expect(deriveMergeRequestStatusKind("locked")).toBe("locked");
  });

  it("downgrades unknown / missing state to open instead of throwing", () => {
    for (const s of ["draft", "weird_new_state", "", null, undefined]) {
      expect(deriveMergeRequestStatusKind(s)).toBe("open");
    }
  });
});
