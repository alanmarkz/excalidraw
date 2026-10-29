import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import { saveFilesToFirebase } from "../data/firebase";

describe("saveFilesToFirebase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject when the storage server can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    await expect(
      saveFilesToFirebase({
        prefix: "/files/shareLinks/id",
        files: [{ id: "file" as FileId, buffer: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow();
  });
});
