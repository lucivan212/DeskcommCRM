// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "@/lib/mcp/types";
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));
vi.mock("@/lib/api/idempotency", () => ({ comIdempotencia: vi.fn() }));
vi.mock("@/lib/mcp/conferencia-de-campos", () => ({ conferirCamposPersonalizados: vi.fn() }));
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { comIdempotencia } from "@/lib/api/idempotency";
import { conferirCamposPersonalizados } from "@/lib/mcp/conferencia-de-campos";
import { crmCreateLead } from "@/lib/mcp/tools/leads";
const input = {
  pipeline_id: "aaaaaaaa-0000-4000-8000-000000000001",
  stage_id: "aaaaaaaa-0000-4000-8000-000000000002",
  title: "Lead de teste",
  custom_fields: { origem: "teste" },
};
const ctx = {
  supabase: {},
  organizationId: "aaaaaaaa-0000-4000-8000-000000000003",
  actor: { type: "user", id: "user-test" },
  requestId: "test",
  idempotencyKey: "same-key",
} as unknown as McpContext;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(conferirCamposPersonalizados).mockResolvedValue({
    custom_fields: input.custom_fields,
    recusados: [],
    estado: "teste",
  });
  vi.mocked(createLeadHandler).mockResolvedValue({ id: "lead-test" } as never);
});
describe("customização IAOS preservada na atualização", () => {
  it("replay devolve o recibo sem criar outro negócio", async () => {
    vi.mocked(comIdempotencia).mockResolvedValue({
      tipo: "replay",
      resposta: { lead: { id: "saved" } },
      status: 201,
    } as never);
    expect(await crmCreateLead.handler(input, ctx)).toEqual({ lead: { id: "saved" } });
    expect(createLeadHandler).not.toHaveBeenCalled();
    expect(comIdempotencia).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ctx.organizationId,
        chave: "same-key",
        corpo: expect.objectContaining({ custom_fields: input.custom_fields }),
      }),
    );
  });
  it("sem chave preserva os campos novos e a criação usual", async () => {
    await crmCreateLead.handler(input, { ...ctx, idempotencyKey: undefined });
    expect(createLeadHandler).toHaveBeenCalledWith(
      ctx.supabase,
      expect.objectContaining({ organization_id: ctx.organizationId }),
      expect.objectContaining({ custom_fields: input.custom_fields }),
    );
    expect(comIdempotencia).not.toHaveBeenCalled();
  });
  it.each([
    ["conflito", "idempotency_conflict"],
    ["em_curso", "idempotency_in_progress"],
  ])("%s não cria negócio", async (tipo, erro) => {
    vi.mocked(comIdempotencia).mockResolvedValue({ tipo } as never);
    await expect(crmCreateLead.handler(input, ctx)).rejects.toThrow(erro);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });
});
