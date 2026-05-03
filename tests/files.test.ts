import { describe, expect, it } from "vitest";
import { frameFolderName, sanitizeFilename } from "../src/utils/files";

describe("file utilities", () => {
  it("sanitizes names for Windows paths", () => {
    expect(sanitizeFilename("A/B:C*D?")).toBe("A-B-C-D");
    expect(sanitizeFilename("CON")).toBe("CON-file");
  });

  it("builds frame folder names with stable node ids", () => {
    expect(frameFolderName("Login / Mobile", "12:34")).toBe("Login-Mobile__12-34");
  });
});
