import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { IdentityManager } from "../identity/index.js";
import { LocalDatabase } from "../localdb/index.js";
import { Publisher } from "../publish/publisher.js";

describe("Publisher indexFiles error reporting", () => {
  let testDir: string;
  let dbPath: string;
  let identityDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `overlay-index-errors-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, "localfiles.db");
    identityDir = join(testDir, "identity");
    mkdirSync(identityDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests.
    }
  });

  it("logs summarized indexing failures instead of one stack trace per file", async () => {
    const identity = new IdentityManager(identityDir);
    await identity.initialize();

    const localDb = new LocalDatabase(dbPath);
    const publisher = new Publisher(identity, localDb);

    const fileOne = join(testDir, "one.mp3");
    const fileTwo = join(testDir, "two.mp3");
    const fileThree = join(testDir, "three.mp3");
    writeFileSync(fileOne, "a".repeat(2048));
    writeFileSync(fileTwo, "b".repeat(2048));
    writeFileSync(fileThree, "c".repeat(2048));

    const scanResults = [fileOne, fileTwo, fileThree].map((filePath) => {
      const stats = statSync(filePath);
      return {
        path: filePath,
        filename: filePath.split("/").pop() || filePath,
        size: stats.size,
        mtime: stats.mtimeMs,
        ext: "mp3" as const,
      };
    });

    localDb.close();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const entries = await publisher.indexFiles(scanResults);

    expect(entries).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(3);

    const warnOutput = warnSpy.mock.calls.flat().join(" ").toLowerCase();
    expect(warnOutput).toContain("failed to index 3 file(s)");
    expect(warnOutput).toContain("database connection is not open");
  });
});
