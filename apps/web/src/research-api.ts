import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ideasPage,
  queuedReply,
  vaultPaperNote,
  vaultStatus,
  type NewVaultRequest,
} from "@litscout/pipeline/vault-contracts";
import { vaultInfo } from "@litscout/pipeline/research-contracts";
import { apiGet, apiMutation } from "./api";

export const researchKeys = ["ideas", "working-papers", "suggestions", "vault"];
export function useIdeas(enabled = true) {
  return useInfiniteQuery({
    queryKey: ["ideas"],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      apiGet(
        "/ideas" + (pageParam ? "?after=" + pageParam : ""),
        ideasPage,
        signal,
      ),
    getNextPageParam: (page) => page.next ?? undefined,
    enabled,
  });
}

export function useVaultPaper(paperId: string) {
  return useQuery({
    queryKey: ["vault", "paper-note", paperId],
    queryFn: ({ signal }) =>
      apiGet(
        "/vault/paper-note/" + encodeURIComponent(paperId),
        vaultPaperNote,
        signal,
      ),
  });
}

export function useVaultInfo() {
  return useQuery({
    queryKey: ["vault", "info"],
    queryFn: ({ signal }) => apiGet("/vault/info", vaultInfo, signal),
  });
}

export function useVaultStatus() {
  return useQuery({
    queryKey: ["vault", "status"],
    queryFn: ({ signal }) => apiGet("/vault/status", vaultStatus, signal),
  });
}

export function useRefreshResearch() {
  const client = useQueryClient();
  return () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        researchKeys.some((key) => key === queryKey[0]),
    });
}

export function useVaultRequest() {
  const refresh = useRefreshResearch();
  return useMutation({
    mutationFn: (data: NewVaultRequest) =>
      apiMutation("/vault/requests", "POST", data, queuedReply),
    onSuccess: refresh,
  });
}
