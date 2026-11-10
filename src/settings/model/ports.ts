/**
 * The flat {VAR: value} auth.json map (AUTH_FILE). Values are opaque: shape
 * validation and env precedence live in keys.ts. Unknown vars are preserved.
 */
export interface AuthStore {
	/** The whole map — {} for an absent or corrupt file. Never throws. */
	authVars(): Record<string, string>;
	/** Set one var (atomic write, mode 0600, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one var if present. */
	deleteAuthVar(name: string): void;
}
