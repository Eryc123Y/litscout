import { expect, it } from "vitest";
import { remoteDigestResearch } from "../src/digest-research";

it("builds the digest research context from the instance's vault index, page by page", async () => {
  const pages: Record<string, unknown> = {
    "/projects": {
      items: [
        {
          id: "p1",
          title: "Medium",
          path: "a.md",
          status: " Active ",
          summary: "Ablation",
        },
      ],
      next: "p1",
    },
    "/projects?after=p1": {
      items: [{ id: "p2", title: "Lean", path: "b.md", status: null }],
      next: null,
    },
    "/ideas": {
      items: [
        {
          id: "i1",
          title: "Seed idea",
          path: "c.md",
          status: "seed",
          project: "p1",
        },
        { id: "i2", title: "Done idea", path: "d.md", status: "done" },
        {
          id: "i3",
          title: "Exploring",
          path: "e.md",
          status: "Exploring",
          description: "x",
        },
      ],
      next: null,
    },
  };
  const asked: string[] = [];
  const research = await remoteDigestResearch(async (path) => {
    asked.push(path);
    return pages[path];
  });
  expect(asked.sort()).toEqual(["/ideas", "/projects", "/projects?after=p1"]);
  expect(research.bodies).toEqual([]);
  expect(research.fields.vaultProjects).toEqual([
    {
      id: "p1",
      title: "Medium",
      path: "a.md",
      status: "active",
      description: "Ablation",
    },
    { id: "p2", title: "Lean", path: "b.md", status: null, description: null },
  ]);
  expect(research.fields.openIdeas).toEqual([
    {
      id: "i1",
      title: "Seed idea",
      path: "c.md",
      status: "seed",
      description: null,
      project: "p1",
    },
    {
      id: "i3",
      title: "Exploring",
      path: "e.md",
      status: "exploring",
      description: "x",
      project: null,
    },
  ]);
});

it("rejects an unexpected page shape instead of writing an empty context", async () => {
  await expect(
    remoteDigestResearch(async () => ({ projects: [] })),
  ).rejects.toThrow();
});
