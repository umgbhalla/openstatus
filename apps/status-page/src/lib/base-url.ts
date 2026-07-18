export function getBaseUrl({
  slug,
  customDomain,
}: {
  slug?: string;
  customDomain?: string;
}) {
  if (process.env.NODE_ENV === "development") {
    return `http://localhost:3000/${slug}`;
  }
  if (customDomain) {
    return `https://${customDomain}`;
  }
  const baseUrl = process.env.STATUS_PAGE_BASE_URL?.replace(/\/$/, "");
  if (baseUrl) {
    return `${baseUrl}/${slug}`;
  }
  if (process.env.SELF_HOST === "true") {
    throw new Error("STATUS_PAGE_BASE_URL is required when SELF_HOST=true");
  }
  return `https://${slug}.openstatus.dev`;
}
