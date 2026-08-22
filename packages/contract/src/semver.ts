import { z } from 'zod';

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const StrictSemVer = z
  .string()
  .trim()
  .min(1)
  .refine((value) => STRICT_SEMVER_PATTERN.test(value), {
    message: 'version must be a strict SemVer value',
  });
export type StrictSemVer = z.infer<typeof StrictSemVer>;
