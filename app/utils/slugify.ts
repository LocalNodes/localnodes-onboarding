/**
 * Convert a community name to a valid DNS subdomain label.
 * Rules: lowercase, alphanumeric + hyphens, no leading/trailing hyphens,
 * no consecutive hyphens, max 63 characters.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove non-alphanumeric except spaces and hyphens
    .replace(/[\s]+/g, '-')         // Replace spaces with hyphens
    .replace(/-{2,}/g, '-')         // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, '')        // Trim leading/trailing hyphens
    .slice(0, 63)                   // DNS label max length
}
