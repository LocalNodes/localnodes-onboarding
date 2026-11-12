export type ClaimPage = '/' | '/for'
export interface LaunchClaim {
  readonly id: string
  readonly page: ClaimPage
  readonly text: string
  readonly ready: boolean
  readonly until: string
  readonly evidence?: string
}
export const CLAIM_PAGES: readonly ClaimPage[]
export const LAUNCH_CLAIMS: readonly LaunchClaim[]
export function claimsOn(page: ClaimPage, claims?: readonly LaunchClaim[]): LaunchClaim[]
export function isLaunchFlagOpen(value: string | undefined): boolean
export function mightOpen(value: string | undefined): boolean
export function pendingClaims(claims?: readonly LaunchClaim[]): LaunchClaim[]
export function launchGateProblem(flag: string | undefined, claims?: readonly LaunchClaim[]): string | null
export function serverLaunchOpen(flagOpen: boolean, opts: { dev: boolean | undefined, claims?: readonly LaunchClaim[] }): boolean
export function missingClaims(pageText: string, claims?: readonly LaunchClaim[]): LaunchClaim[]
