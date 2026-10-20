/** Server-only WorkOS credential. Never imported by the device application. */
export interface AuthorizationProvider {
  revoke(accountId: string, clientId: string): Promise<"requested" | "not_available" | "failed">;
}
export class WorkOSAuthorizationProvider implements AuthorizationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async revoke(accountId: string, clientId: string): Promise<"requested" | "failed"> {
    try {
      // WorkOS User API: delete the user's authorized application, NOT the shared Connect application.
      const url = `https://api.workos.com/user_management/users/${encodeURIComponent(accountId)}/authorized_applications/${encodeURIComponent(clientId)}`;
      const r = await this.request(url, {
        method: "DELETE",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      await r.body?.cancel();
      return r.ok || r.status === 404 ? "requested" : "failed";
    } catch {
      return "failed";
    }
  }
}
