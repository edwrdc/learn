import type { JobKind } from "../../tools/model/index.ts";
import { DEMO_ROLE } from "./demo.ts";
import { PDF_ROLE } from "./pdf.ts";
import { RESEARCH_ROLE } from "./research.ts";
import type { JobRole } from "./role.ts";
import { VISUAL_ROLE } from "./visual.ts";

export const JOB_ROLES: Record<JobKind, JobRole<any, any, any>> = {
	research: RESEARCH_ROLE,
	demo: DEMO_ROLE,
	visual: VISUAL_ROLE,
	pdf: PDF_ROLE,
};
