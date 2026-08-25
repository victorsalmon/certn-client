/**
 * Allow-listed, versioned Certn screening profiles.
 *
 * Callers select a profile NAME (`identity`, `credit`, `risk`) instead of a
 * raw Certn check type — check identifiers are versioned
 * (`IDENTITY_VERIFICATION_1`) and the retired legacy label (`softcheck`)
 * must never appear in code.
 *
 * The identifiers below come from the current Certn Centric catalog. Availability,
 * arguments, and pricing differ per environment — before production enablement,
 * re-verify each identifier against the sandbox Check Finder and record the
 * confirmed payloads in your own docs.
 */

export interface ScreeningProfile {
  /** Allow-listed profile name callers use in the UI/API. */
  readonly name: string;
  /** Version of the check identifiers (bump when the catalog changes them). */
  readonly version: number;
  /** Current Certn check identifier for this profile. */
  readonly checkTypesWithArguments: Record<string, Record<string, unknown>>;
  /** What the profile covers, for staff-facing labels. */
  readonly label: string;
}

/** Allow-listed profile used when the caller does not specify one. */
export const DEFAULT_PROFILE_NAME = 'identity';

export const SCREENING_PROFILES: readonly ScreeningProfile[] = [
  {
    name: 'identity',
    version: 1,
    label: 'Identity verification',
    checkTypesWithArguments: { IDENTITY_VERIFICATION_1: {} },
  },
  {
    name: 'credit',
    version: 1,
    label: 'Credit report',
    // Credit and criminal checks are umbrella parents. The Certn catalog
    // requires explicit ordering with the Canadian child check plus identity
    // verification as a waterfall dependency.
    checkTypesWithArguments: {
      CREDIT_REPORT_1: {
        ordering_type: 'EXPLICIT_ORDERING',
        explicit_check_type: ['CANADIAN_CREDIT_REPORT_1'],
      },
      IDENTITY_VERIFICATION_1: {},
    },
  },
  {
    name: 'risk',
    version: 1,
    label: 'Risk screening (criminal record)',
    checkTypesWithArguments: {
      CRIMINAL_RECORD_REPORT_1: {
        ordering_type: 'EXPLICIT_ORDERING',
        explicit_check_type: ['BASIC_CANADIAN_CRIMINAL_RECORD_REPORT_1'],
      },
      IDENTITY_VERIFICATION_1: {},
    },
  },
];

/** Comma-separated list of allow-listed profile names for error messages. */
const ALLOWED_PROFILE_NAMES = SCREENING_PROFILES.map((p) => p.name).join(', ');

const PROFILE_BY_NAME: ReadonlyMap<string, ScreeningProfile> = new Map(
  SCREENING_PROFILES.map((profile) => [profile.name, profile])
);

/** Resolve a profile by name — throws on unknown/legacy names. */
export function getScreeningProfile(name: string): ScreeningProfile {
  const profile = PROFILE_BY_NAME.get(name);
  if (!profile) {
    throw new Error(
      `Unknown screening profile: ${name}. Allowed: ${ALLOWED_PROFILE_NAMES}`
    );
  }
  return profile;
}

/** True when the profile name is allow-listed (case-sensitive). */
export function isScreeningProfile(name: string): boolean {
  return PROFILE_BY_NAME.has(name);
}
