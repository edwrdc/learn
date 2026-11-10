import type { ActivityFeed } from "@/src/jobs/model";
import { getJson } from "./http";

export const fetchActivity = () => getJson<ActivityFeed>("/api/activity");
