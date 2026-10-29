// @vitest-environment node
/** Entrega privada, nomes originais, autorização e falhas sem fallback do canal. */
import { NextRequest } from "next/server";
import { createClient as criarClienteDoSdk } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Channels from "@/lib/channels";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/messaging/media/voice-transcode", () => ({
  ConversorOcupado: class extends Error {},
  TETO_REPRODUCAO_BYTES: 1024,
  paraReproducaoAac: vi.fn(),
}));
vi.mock("@/lib/channels", async () => {
  const actual = await vi.importActual<typeof Channels>("@/lib/channels");
  return {
    ...actual,
    getAdapter: vi.fn(),
    // O ref da sessão é só o endereço do canal; o adapter é quem busca os bytes.
    resolveSessionRef: vi.fn(() => ({ provider: actual.DEFAULT_CHANNEL_PROVIDER, sessionName: "sessao-de-teste" })),
  };
});

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { DEFAULT_CHANNEL_PROVIDER, getAdapter } from "@/lib/channels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MENSAGEM = "55555555-5555-4555-8555-555555555555";
const SESSAO = "66666666-6666-4666-8666-666666666666";
const NOME = "Relatorio_Vendas_Outubro.xlsx";

type Linha = {
  id: string;
  organization_id: string;
  media_url: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
  channel_session_id: string | null;
};

/** O que foi pedido ao Storage — o único lugar onde o nome pode virar download. */
const DOWNLOADS: Array<{ bucket: string; path: string }> = [];
const baixarObjeto = vi.fn();
const assinar = vi.fn();

let MENSAGENS: Linha[] = [];

function linha(over: Partial<Linha> = {}): Linha {
  return {
    id: MENSAGEM,
    organization_id: ORG_ID,
    media_url: null,
    media_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    media_size_bytes: 2048,
    media_storage_path: `${ORG_ID}/conv/${MENSAGEM}.xlsx`,
    metadata: null,
    channel_session_id: SESSAO,
    ...over,
  };
}

function consultaDeMensagens() {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    maybeSingle: async () => ({
      data:
        MENSAGENS.find((m) =>
          filtros.every(
            ([c, v]) => (m as unknown as Record<string, unknown>)[c] === v,
          ),
        ) ?? null,
      error: null,
    }),
  };
  return q;
}

function adminFake() {
  const sessao = {
    select: () => sessao,
    eq: () => sessao,
    maybeSingle: async () => ({ data: { provider: DEFAULT_CHANNEL_PROVIDER }, error: null }),
  };
  return {
    from: () => sessao,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: assinar,
        download: async (path: string) => {
          DOWNLOADS.push({ bucket, path });
          return baixarObjeto();
        },
      }),
    },
  };
}

function url(consulta = ""): string {
  return `http://localhost/api/v1/messages/${MENSAGEM}/media${consulta}`;
}

const PARAMS = { params: Promise.resolve({ id: MENSAGEM }) };

beforeEach(() => {
  vi.clearAllMocks();
  DOWNLOADS.length = 0;
  baixarObjeto.mockReset();
  baixarObjeto.mockResolvedValue({ data: new Blob(["%PDF-test"], { type: "application/pdf" }), error: null });
  MENSAGENS = [];
  vi.mocked(createAdminClient).mockReturnValue(adminFake() as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: () => consultaDeMensagens(),
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USER_ID, idioma: "pt-BR" } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({
    ok: true,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, limit: 30, count: 1 } as never);
});

describe("bytes privados persistidos", () => {
  it.each(["application/pdf", "image/jpeg"])("abre %s sem redirecionar", async (mime) => {
    const bytes = mime === "application/pdf" ? Buffer.from("%PDF-test") : Buffer.from([255, 216, 255, 224]);
    baixarObjeto.mockResolvedValue({ data: new Blob([bytes], { type: mime }), error: null });
    MENSAGENS = [linha()];
    const res = await GET(new NextRequest(url()), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe(mime);
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    expect(DOWNLOADS).toEqual([{ bucket: "whatsapp-media", path: linha().media_storage_path }]);
    expect(assinar).not.toHaveBeenCalled();
  });

  it.each([NOME, "Orçamento Ação 2026.pdf", "Planilha [100%] + final.xlsx"])(
    "download preserva o nome original %s", async (nome) => {
      MENSAGENS = [linha({ metadata: { media_filename: nome } })];
      const res = await GET(new NextRequest(url("?baixar=1")), PARAMS);
      expect(res.status).toBe(200);
      const cd = res.headers.get("content-disposition")!;
      expect(cd).toMatch(/^attachment;/);
      expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1]!)).toBe(nome);
    },
  );

  it.each([null, { raw_type: "document" }])("sem nome usa o basename canônico (%j)", async (metadata) => {
    MENSAGENS = [linha({ metadata })];
    const res = await GET(new NextRequest(url("?baixar=1")), PARAMS);
    expect(res.headers.get("content-disposition")).toContain(`attachment; filename="${MENSAGEM}.xlsx"`);
  });

  it.each(["", "?baixar=0", "?baixar=true"])("preview permanece inline (%s)", async (query) => {
    MENSAGENS = [linha({ metadata: { media_filename: NOME } })];
    const res = await GET(new NextRequest(url(query)), PARAMS);
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  it.each(["text/html", "image/svg+xml", "", "application/x-unknown"])("não abre tipo ativo/desconhecido %s inline", async (mime) => {
    MENSAGENS = [linha()];
    baixarObjeto.mockResolvedValue({ data: new Blob(["conteudo"], { type: mime }) });
    const res = await GET(new NextRequest(url()), PARAMS);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([["404", 404], [404, 404], ["500", 502], [undefined, 502]])(
    "falha do Storage %s vira %s sem consultar o canal", async (statusCode, status) => {
      MENSAGENS = [linha({ media_url: "https://canal.test/media/abc" })];
      baixarObjeto.mockResolvedValue({ data: null, error: { statusCode } });
      const res = await GET(new NextRequest(url()), PARAMS);
      expect(res.status).toBe(status);
      expect(res.headers.get("location")).toBeNull();
      expect(getAdapter).not.toHaveBeenCalled();
    },
  );

  it("exceção do SDK vira 502, sem fallback", async () => {
    MENSAGENS = [linha({ media_url: "https://canal.test/media/abc" })];
    baixarObjeto.mockRejectedValue(new Error("falha sintética"));
    expect((await GET(new NextRequest(url()), PARAMS)).status).toBe(502);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("sem sessão não consulta Storage", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as never);
    expect((await GET(new NextRequest(url()), PARAMS)).status).toBe(401);
    expect(DOWNLOADS).toEqual([]);
  });

  it("mensagem de outra organização não consulta Storage", async () => {
    MENSAGENS = [linha({ organization_id: "outra-org" })];
    expect((await GET(new NextRequest(url()), PARAMS)).status).toBe(404);
    expect(DOWNLOADS).toEqual([]);
  });

  it("sem organização ativa não consulta Storage", async () => {
    vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: null } as never);
    expect((await GET(new NextRequest(url()), PARAMS)).status).toBe(403);
    expect(DOWNLOADS).toEqual([]);
  });

  it("id inválido não consulta Storage", async () => {
    expect((await GET(new NextRequest(url()), { params: Promise.resolve({ id: "inválido" }) })).status).toBe(404);
    expect(DOWNLOADS).toEqual([]);
  });
});

describe("janela do worker (bytes ainda no canal)", () => {
  function semBytes(metadata: Record<string, unknown>) {
    MENSAGENS = [
      linha({
        media_storage_path: null,
        media_url: "https://canal.test/media/abc",
        metadata,
      }),
    ];
    vi.mocked(getAdapter).mockReturnValue({
      fetchInboundMedia: async () => ({
        buffer: Buffer.from("bytes-de-teste"),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    } as never);
  }

  it("devolve Content-Disposition com filename e filename* (RFC 5987)", async () => {
    semBytes({ media_filename: "Relatório Ção.xlsx" });

    const res = await GET(new NextRequest(url("?baixar=1")), PARAMS);

    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).toContain('filename="Relatorio Cao.xlsx"');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("Relatório Ção.xlsx")}`);
  });

  it("sem nome original, o proxy não inventa Content-Disposition", async () => {
    semBytes({ raw_type: "document" });

    const res = await GET(new NextRequest(url("?baixar=1")), PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBeNull();
  });
});


describe("SDK real com transporte sintético (sem rede)", () => {
  it("baixa bytes pela origem interna sem expor a URL e preserva o nome", async () => {
    const transporte = vi.fn(async () => new Response("%PDF-sintetico", {
      headers: { "Content-Type": "application/pdf" },
    }));
    const sdk = criarClienteDoSdk("http://storage.invalid:8000", "chave-ficticia", {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: "sdk-rota-media-teste" },
      global: { fetch: transporte },
    });
    vi.mocked(createAdminClient).mockReturnValue({ storage: sdk.storage } as never);
    MENSAGENS = [linha({ metadata: { media_filename: "Orçamento [100%].pdf" } })];
    const res = await GET(new NextRequest(url("?baixar=1")), PARAMS);
    expect(transporte).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("%PDF-sintetico");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''Or%C3%A7amento%20%5B100%25%5D.pdf");
  });
});
