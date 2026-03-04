export async function dispatchProvisioningWorkflow(params: {
  subdomain: string
  siteName: string
  email: string
  stripeSessionId: string
}): Promise<{ runId: number; runUrl: string }> {
  const config = useRuntimeConfig()

  const response = await fetch(
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
        inputs: {
          subdomain: params.subdomain,
          site_name: params.siteName,
          email: params.email,
          stripe_session_id: params.stripeSessionId,
          demo_module: 'localnodes_demo',
          callback_url: 'https://localnodes.xyz'
        }
      })
    }
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`GitHub API error (${response.status}): ${error}`)
  }

  const data = await response.json()
  return {
    runId: data.workflow_run_id,
    runUrl: data.html_url
  }
}
