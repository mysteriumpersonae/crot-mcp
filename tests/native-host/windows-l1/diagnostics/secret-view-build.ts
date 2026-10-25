/** AD-57 tombstone: third-party-driver provisioning is prohibited, including in CI.
 * Retained for the mandatory positive native gate so removing a rejected
 * dependency cannot silently turn an unimplemented replacement into Pass.
 */
export function buildSecretViewFixture(): Promise<{
  helper: string;
  proof: string;
  cleanup(): Promise<void>;
}> {
  return Promise.reject(
    new Error(
      "AD-57: third-party filesystem driver provisioning is disabled. " +
        "A driver-free Windows future-secret projection has not passed native admission; no fallback is permitted.",
    ),
  );
}
