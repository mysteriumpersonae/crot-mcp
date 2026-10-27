/** Agents can request a draft, never a permit, credential or platform send. */
import type { AuthContext } from "../../auth/principal.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import { CrotError } from "../../errors.js";
import { PublicationRequestSchema } from "../../publications/schemas.js";
import type { PublicationRecord } from "../../publications/service.js";
export type PreparePublicationHandler = (context: AuthContext, input: unknown) => Promise<PublicationRecord>;
export class PublicationPreparationService {
  constructor(
    private readonly guard: ExecutionGuard,
    private readonly prepare?: PreparePublicationHandler,
  ) {}
  async preparePublication(context: AuthContext, input: unknown): Promise<PublicationRecord> {
    const request = PublicationRequestSchema.parse(input);
    return this.guard.run(
      context,
      {
        operation: "publication.prepare",
        capability: [],
        details: { provider: request.provider },
      },
      async () => {
        if (!this.prepare) throw new CrotError("PERMISSION_DENIED", "Publication runtime unavailable");
        return this.prepare(context, request);
      },
    );
  }
}
