import { persistInverted } from "./artifact-ui";

/** Light figures inverted for the dark UI (hue-rotate keeps colors legible). */
export const INVERT_FILTER = "filter: invert(1) hue-rotate(180deg)";

/** An artifact card's invert switch, persisted on its steer message. */
export class InvertSwitch {
	on = $state(false);

	constructor(
		initial: boolean,
		private readonly chatId: () => string | undefined,
		private readonly messageId: () => string | undefined,
	) {
		this.on = initial;
	}

	set = (next: boolean): void => {
		this.on = next;
		persistInverted(this.chatId(), this.messageId(), next);
	};
}
