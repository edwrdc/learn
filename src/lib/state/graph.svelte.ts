/** The knowledge-graph snapshot (GET /api/graph), shared by every view.
 *  A deletion (graph-revision) reloads it; each view also reloads it when
 *  its own view of the world changes (GraphView: a run finished, so a
 *  drag is never interrupted mid-run). */
import { fetchGraph } from "$lib/api/graph";
import { onAppEvent } from "$lib/events";
import { Resource } from "./resource.svelte";

export const graphSnapshot = new Resource("graph", fetchGraph);

onAppEvent("graph-revision", () => void graphSnapshot.refresh());
