/**
 * CLUSTER PRESENTATION RULES. Detection is birth-session clustering
 * (session-clusters.ts; labels are session names). What remains here is
 * the one presentation rule the snapshot and the renderer share.
 */

/** Communities below this size are not rendered, not named — presentation
 *  rule (owner decision): a region of the world model needs at
 *  least three propositions to be worth a hull and a label. */
export const MIN_CLUSTER_SIZE = 3;