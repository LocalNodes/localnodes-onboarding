export interface LaunchClaim {
  readonly id: string
  readonly text: string
  readonly ready: boolean
  readonly until: string
}
export const LAUNCH_CLAIMS: readonly LaunchClaim[]
export function isLaunchFlagOpen(value: string | undefined): boolean
export function mightOpen(value: string | undefined): boolean
export function pendingClaims(claims?: readonly LaunchClaim[]): LaunchClaim[]
export function launchGateProblem(flag: string | undefined, claims?: readonly LaunchClaim[]): string | null
export function missingClaims(pageText: string, claims?: readonly LaunchClaim[]): LaunchClaim[]
