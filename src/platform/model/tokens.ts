/** The app-wide token estimate for text that no provider has counted yet. */
export function tokensForChars(chars: number): number {
	return Math.ceil(chars / 4);
}
