import { db, eq } from "@openstatus/db";
import { page } from "@openstatus/db/src/schema";
import { Status, Tracker } from "@openstatus/tracker";

/**
 * Derives the overall status of a public status page from the local database.
 *
 * Mirrors the server's `/public/status/:slug` handler (DB query + Tracker) so
 * self-host badges resolve against local data instead of the hosted
 * `api.openstatus.dev` (which does not know self-host slugs and therefore
 * returned `unknown`). An empty history defaults to 100% uptime → operational,
 * matching the status page home.
 */
export async function getPageStatus(slug: string): Promise<Status> {
  const currentPage = await db.query.page.findFirst({
    where: eq(page.slug, slug),
    with: {
      pageComponents: {
        with: {
          monitor: {
            with: {
              incidents: true,
            },
          },
        },
      },
      statusReports: true,
      maintenances: true,
    },
  });

  if (!currentPage || currentPage.accessType !== "public") {
    return Status.Unknown;
  }

  const monitorComponents = currentPage.pageComponents.filter(
    (c) =>
      c.type === "monitor" &&
      c.monitor &&
      c.monitor.active &&
      !c.monitor.deletedAt,
  );

  const ongoingIncidents = monitorComponents.flatMap(
    (c) => c.monitor?.incidents?.filter((inc) => !inc.resolvedAt) ?? [],
  );

  const unresolvedStatusReports = currentPage.statusReports.filter(
    (report) => report.status !== "resolved",
  );

  const now = new Date();
  const ongoingMaintenances = currentPage.maintenances.filter(
    (m) => m.from <= now && m.to >= now,
  );

  const tracker = new Tracker({
    incidents: ongoingIncidents,
    statusReports: unresolvedStatusReports,
    maintenances: ongoingMaintenances,
  });

  return tracker.currentStatus;
}
