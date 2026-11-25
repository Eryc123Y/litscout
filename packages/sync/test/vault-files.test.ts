import { fsyncSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateConfig } from "@litscout/core";
import { localVaultSource, openVault } from "../src/vault-source";

vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    linkSync: vi.fn(fs.linkSync),
    mkdirSync: vi.fn(fs.mkdirSync),
  };
});
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: vi.fn(fs.lstat),
    open: vi.fn(fs.open),
    readdir: vi.fn(fs.readdir),
    realpath: vi.fn(fs.realpath),
  };
});

const sync = await vi.importActual<typeof import("node:fs")>("node:fs");
const asyncFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let parent: string, root: string;
beforeEach(async () => {
  parent = await mkdtemp(path.join(tmpdir(), "litscout-vault-files-"));
  root = await realpath(
    (await mkdir(path.join(parent, "vault"), { recursive: true })) as string,
  );
});
afterEach(async () => {
  vi.resetAllMocks();
  await rm(parent, { recursive: true, force: true });
});
const config = () => validateConfig({ vault: { root, write: true } }).vault;

it("counts excluded directories once without reading any of their entries", async () => {
  const deeper = path.join(root, "Archive", "plugins", "cache", ".trash");
  await mkdir(deeper, { recursive: true });
  await writeFile(path.join(deeper, "Nested.md"), "Excluded note");
  await mkdir(path.join(root, "Ideas", ".git"), { recursive: true });
  await writeFile(path.join(root, "Ideas", "Private NDA.md"), "Excluded note");
  await writeFile(path.join(root, "Ideas", ".DS_Store"), "Excluded metadata");
  await writeFile(
    path.join(root, "Ideas", "Visible.md"),
    "---\ntags: [type/idea]\n---\n",
  );
  const settings = config();
  settings.exclude.push("Archive/**");
  const vault = await openVault(settings);
  const result = await localVaultSource(vault, settings).index();
  const excluded = vault.files("Archive")[Symbol.asyncIterator]();
  await expect(excluded.next()).rejects.toThrow("excluded");
  expect(vi.mocked(readdir).mock.calls.map(([directory]) => directory)).toEqual(
    [root, path.join(root, "Ideas")],
  );
  expect(result).toMatchObject({
    notes: [{ path: "Ideas/Visible.md" }],
    issues: [],
    excludedFolders: 2,
    excludedNotes: 1,
  });
});

it("rejects a missing, symlinked or replaced root before opening files", async () => {
  const alternate = path.join(parent, "alternate");
  await expect(openVault({ ...config(), root: alternate })).rejects.toThrow(
    "existing directory",
  );
  await symlink(root, alternate);
  await expect(openVault({ ...config(), root: alternate })).rejects.toThrow(
    "without a symlink",
  );
  vi.mocked(realpath).mockImplementationOnce(async (file) => {
    await rename(root, path.join(parent, "previous"));
    await mkdir(root);
    return asyncFs.realpath(file);
  });
  await expect(openVault(config())).rejects.toThrow("Vault root moved");
});

it("detects a changed root during enumeration", async () => {
  const vault = await openVault(config());
  await writeFile(path.join(root, "One.md"), "Content");
  const iterator = vault.files()[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: "One.md" });
  await rename(root, path.join(parent, "previous"));
  await mkdir(root);
  await expect(iterator.next()).rejects.toThrow("Vault root moved");
});

it("rejects replacement before or after opening a note", async () => {
  const vault = await openVault(config()),
    file = path.join(root, "Paper.md");
  for (const afterOpen of [false, true]) {
    await writeFile(file, "Expected");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const replace = async () => {
        await rename(file, file + ".old");
        await writeFile(file, "Another file");
      };
      if (!afterOpen) await replace();
      const handle = await asyncFs.open(...args);
      if (afterOpen) await replace();
      return handle;
    });
    await expect(vault.read("Paper.md")).rejects.toThrow("file moved");
  }
});

it("reports a file shortened mid-read and propagates non-missing OS errors", async () => {
  const vault = await openVault(config()),
    file = path.join(root, "Paper.md");
  await writeFile(file, "Expected");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await asyncFs.open(...args);
    vi.spyOn(handle, "read").mockImplementationOnce(async () => {
      await truncate(file, 0);
      return { bytesRead: 0, buffer: Buffer.alloc(0) };
    });
    return handle;
  });
  await expect(vault.read("Paper.md")).rejects.toThrow("changed during sync");
  vi.mocked(lstat).mockRejectedValueOnce(
    Object.assign(new Error("fixture permission failure"), { code: "EACCES" }),
  );
  await expect(vault.read("Paper.md")).rejects.toThrow("permission failure");
});

it("keeps a file created by another writer during directory or note creation", async () => {
  const vault = await openVault(config());
  vi.mocked(mkdirSync).mockImplementationOnce((target, options) => {
    writeFileSync(target, "Another writer");
    return sync.mkdirSync(target, options);
  });
  await expect(vault.write("Nested/Note.md", null, "new")).rejects.toThrow(
    "symlinks",
  );
  expect(await readFile(path.join(root, "Nested"), "utf8")).toBe(
    "Another writer",
  );

  vi.mocked(linkSync).mockImplementationOnce((temp, target) => {
    writeFileSync(target, "Created concurrently", { flag: "wx" });
    sync.linkSync(temp, target);
  });
  await expect(vault.write("Note.md", null, "new")).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(path.join(root, "Note.md"), "utf8")).toBe(
    "Created concurrently",
  );
  expect(await readdir(root)).toEqual(["Nested", "Note.md"]);
});

it("removes the temporary file and keeps a human edit made before replacement", async () => {
  const vault = await openVault(config()),
    target = path.join(root, "Note.md");
  await writeFile(target, "old");
  vi.mocked(fsyncSync).mockImplementationOnce((fd) => {
    sync.fsyncSync(fd);
    writeFileSync(target, "Human edit made concurrently");
  });
  await expect(vault.write("Note.md", "old", "new")).rejects.toThrow(
    "changed during sync",
  );
  expect(await readFile(target, "utf8")).toBe("Human edit made concurrently");
  expect(await readdir(root)).toEqual(["Note.md"]);
});
