import { describe, expect, it } from "vitest";
import { cleanFileName, contentDisposition } from "./fpbAttachments";

describe("attachment file names", () => {
  it("keeps the name but drops paths, quotes and control characters", () => {
    expect(cleanFileName("C:\\Users\\a\\Report Q3.pdf")).toBe("Report Q3.pdf");
    expect(cleanFileName('../../etc/"passwd"')).toBe("passwd");
    expect(cleanFileName("")).toBe("file");
  });

  it("writes a header-safe Content-Disposition with the real name too", () => {
    expect(contentDisposition("attachment", "ریپورٹ.pdf")).toBe(
      `attachment; filename="______.pdf"; filename*=UTF-8''${encodeURIComponent("ریپورٹ.pdf")}`
    );
    expect(contentDisposition("inline", 'a"b.png')).toBe(
      `inline; filename="a_b.png"; filename*=UTF-8''${encodeURIComponent('a"b.png')}`
    );
  });
});
