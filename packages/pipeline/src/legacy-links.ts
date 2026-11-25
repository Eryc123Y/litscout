import type { PaperInput } from "./contracts/index";

type Link = PaperInput["links"][number];
export type ArxivLinkRecipe = { kind: "landing" | "pdf_arxiv"; id: string };

function arxivLink({ kind, id }: ArxivLinkRecipe): Link {
  const path = kind === "landing" ? "abs" : "pdf";
  return {
    kind,
    url: `https://arxiv.org/${path}/${id}`,
    licence: null,
    oaStatus: "unknown",
  };
}

export function readDerivedArxivLinks(
  recipes: string | ArxivLinkRecipe[] | null | undefined,
) {
  const rows =
    typeof recipes === "string"
      ? (JSON.parse(recipes) as ArxivLinkRecipe[])
      : recipes;
  return (rows ?? []).map(arxivLink);
}

function reproducible(link: Link, recipe: ArxivLinkRecipe) {
  const derived = arxivLink(recipe);
  return (
    link.kind === derived.kind &&
    link.url === derived.url &&
    link.licence === derived.licence &&
    link.oaStatus === derived.oaStatus
  );
}

export function legacyArxivLinkRecipes(paper: PaperInput): ArxivLinkRecipe[] {
  return paper.identifiers.flatMap(({ scheme, value }) => {
    const id = value.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
    if (
      scheme !== "arxiv" ||
      !/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/i.test(id)
    )
      return [];
    return (["landing", "pdf_arxiv"] as const).flatMap((kind) => {
      const recipe = { kind, id };
      return paper.links.some((link) => reproducible(link, recipe))
        ? [recipe]
        : [];
    });
  });
}

export function storedLegacyLinks(
  paper: PaperInput,
  recipes = legacyArxivLinkRecipes(paper),
) {
  return paper.links.filter(
    (link) => !recipes.some((recipe) => reproducible(link, recipe)),
  );
}
