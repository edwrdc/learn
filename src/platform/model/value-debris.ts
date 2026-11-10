/**
 * Models copy membership values (correctAnswer against option values, quiz
 * type against its literals, practice targets against proposition ids) from
 * their own context and pick up surrounding syntax — e.g. glm-5.3 emitting
 * `correctAnswer: [":parmenides"]`. Strip at every membership comparison,
 * never on free text, which may legitimately carry these characters.
 */

/** Strip surrounding whitespace, colons, periods, quotes and backticks, in
 *  any interleaving (`":value"`, `: value`, `` `value` ``). The interior is
 *  untouched. */
export function stripModelValueDebris(value: string): string {
	return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
