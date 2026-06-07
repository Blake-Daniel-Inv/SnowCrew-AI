import { z } from 'zod';

/**
 * Zod schemas for credential-related routes. PR 1 has no routes yet —
 * these are defined now so PR 2 (OAuth callback / connect routes) can
 * import them without churning the schema layer in a follow-up.
 */

const SHORT = 200;

/**
 * Whitelist of providers we encrypt credentials for. Adding a new
 * provider means widening this enum AND making sure the read side
 * (PR 3 GitHub tools) knows about it.
 */
export const CredentialProviderSchema = z.enum(['github']);
export type CredentialProviderT = z.infer<typeof CredentialProviderSchema>;

/**
 * Per-credential metadata blob. Non-secret context attached by the
 * server (e.g. GitHub org memberships). `.strict()` so unknown fields
 * can't smuggle in via the JSON response payload.
 */
export const CredentialMetadataSchema = z
  .object({
    organizations: z
      .array(
        z
          .object({
            login: z.string().max(SHORT),
            id: z.number().int().nonnegative(),
            description: z.string().nullable(),
            avatarUrl: z.string().nullable(),
          })
          .strict()
      )
      .max(200)
      .optional(),
  })
  .strict();
export type CredentialMetadataT = z.infer<typeof CredentialMetadataSchema>;

/**
 * Public-safe shape of a stored credential — mirrors the
 * UserCredentialPublic interface in src/types/index.ts. Used to validate
 * responses going back to the browser, where we must never echo
 * ciphertext or scopes-as-string-blob.
 */
export const CredentialPublicSchema = z
  .object({
    provider: CredentialProviderSchema,
    accountLogin: z.string().max(SHORT).nullable(),
    accountId: z.string().max(SHORT).nullable(),
    scopes: z.array(z.string().max(SHORT)).max(50),
    connectedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
    expiresAt: z.number().int().nonnegative().nullable(),
    metadata: CredentialMetadataSchema.optional(),
  })
  .strict();
export type CredentialPublicT = z.infer<typeof CredentialPublicSchema>;
