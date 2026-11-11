// Dispatch of provision-instance.yml in the product repo (Phase 23, plan 23-11).
// The inputs are provision contract v1 (23-03): the site address, the opaque
// provision id, the attempt number and fixed values. The workflow page is
// public, so no email, community name or Stripe session id goes here (D-05);
// the workflow fetches those from the private manifest with a per-site token.

export interface DispatchParams {
  subdomain: string
  provisionId: string
  attempt: number
}

export interface DispatchConfig {
  githubRepo: string
  githubToken: string
  /** Product image tag the workflow pins; empty means the workflow's default. */
  provisionImageTag?: string
}

export interface DispatchDeps {
  config: DispatchConfig
  fetch: typeof fetch
}

export async function dispatchWorkflow(
  params: DispatchParams,
  { config, fetch: doFetch }: DispatchDeps
): Promise<{ runId: number; runUrl: string }> {
  // GitHub rejects inputs the workflow does not declare, and every value is a
  // string. image_tag is optional in the contract, so it is left out when unset.
  const inputs: Record<string, string> = {
    subdomain: params.subdomain,
    provision_id: params.provisionId,
    attempt: String(params.attempt),
    demo_module: 'none',
    gemini_key_tier: 'paid',
    callback_url: 'https://localnodes.xyz'
  }
  if (config.provisionImageTag) inputs.image_tag = config.provisionImageTag

  const response = await doFetch(
    `https://api.github.com/repos/${config.githubRepo}/actions/workflows/provision-instance.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.githubToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: 'main',
        return_run_details: true,
        inputs
      })
    }
  )

  if (!response.ok) {
    // The status only: GitHub's answer can echo inputs, so its text stays out
    // of the error and out of the logs.
    throw new Error(`GitHub dispatch failed (${response.status})`)
  }

  const data = await response.json()
  return {
    runId: data.workflow_run_id,
    runUrl: data.html_url
  }
}

export async function dispatchProvisioningWorkflow(params: DispatchParams): Promise<{ runId: number; runUrl: string }> {
  const config = useRuntimeConfig()
  return dispatchWorkflow(params, {
    config: {
      githubRepo: config.githubRepo,
      githubToken: config.githubToken,
      provisionImageTag: config.provisionImageTag
    },
    fetch
  })
}

export interface TeardownParams {
  subdomain: string
  provisionId: string
}

/**
 * Dispatch of teardown-instance.yml (23-36's workflow; 23-37, D-18 note). The
 * three inputs are public on the run page, so only the address, the opaque
 * provision id and the fixed callback URL go here. The workflow deletes only
 * the app tagged ln-provision:{provision_id}, and only after this app answers
 * GET /api/teardown-check with 200 {"teardown": true}. Same token and repo as
 * the provisioning dispatch; the same error rule: the status only, never
 * GitHub's text.
 */
export async function dispatchTeardownWorkflow(
  params: TeardownParams,
  { config, fetch: doFetch }: DispatchDeps,
  signal?: AbortSignal
): Promise<void> {
  const response = await doFetch(
    `https://api.github.com/repos/${config.githubRepo}/actions/workflows/teardown-instance.yml/dispatches`,
    {
      method: 'POST',
      // The lease's abort signal (23-43): the call ends at DISPATCH_TIMEOUT_MS, connect and body alike.
      signal,
      headers: {
        'Authorization': `Bearer ${config.githubToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: 'main',
        return_run_details: true,
        inputs: {
          subdomain: params.subdomain,
          provision_id: params.provisionId,
          callback_url: 'https://localnodes.xyz'
        }
      })
    }
  )
  if (!response.ok) {
    throw new Error(`GitHub teardown dispatch failed (${response.status})`)
  }
}

/** The production wiring: runtimeConfig's repo and token, the global fetch, and the caller's abort signal. */
export async function dispatchTeardown(params: TeardownParams, signal?: AbortSignal): Promise<void> {
  const config = useRuntimeConfig()
  return dispatchTeardownWorkflow(params, {
    config: { githubRepo: config.githubRepo, githubToken: config.githubToken },
    fetch
  }, signal)
}
