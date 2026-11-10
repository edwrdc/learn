/** The knowledge-graph snapshot (GET /api/graph), shared by every view.
 *  A deletion (graph-revision) reloads it; each view also reloads it when
 *  its own view of the world changes (GraphView: a run finished, so a
 *  drag is never interrupted mid-run). No server events on purpose: a
 *  refetch during a drag broke dragging. */
import { fetchExtractionRuns, fetchGraph, fetchGraphCosts } from "$lib/api/graph";
import { onAppEvent } from "$lib/events";
import { Resource } from "./resource.svelte";

export const graphSnapshot = new Resource("graph", fetchGraph);

/** The graph pipeline's cost summary (GET /api/graph/costs). */
export const graphCosts = new Resource("graph costs", fetchGraphCosts, { events: ["activity-changed"] });

/** The extraction runs in flight (GET /api/graph/status). */
export const extractionRuns = new Resource("graph status", fetchExtractionRuns, { events: ["activity-changed"] });

onAppEvent("graph-revision", () => {
	void graphSnapshot.refresh();
	void graphCosts.refresh();
});
