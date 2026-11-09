/** The app's record ids: `<prefix>_<time>_<random>`, safe as file names. */
export function mintId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Ids name files and directories, so anything else is refused. */
export function isSafeId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id);
}
