/**
 * Centralised cli-table3 style for ALL tables.
 *
 * Why this lives in its own module:
 *   - cli-table3 ignores NO_COLOR / FORCE_COLOR / NODE_DISABLE_COLORS for
 *     its border characters (it uses an internal `colors` package, not
 *     `chalk`). The user has no env-var lever to disable border colors.
 *   - `style: { head: [] }` only disables the header colour, not borders.
 *   - Passing `style: { border: [] }` everywhere gives consistent behaviour:
 *     when NO_COLOR is set, the entire output (text + borders) is plain.
 *
 * If you create a new Table somewhere, import TABLE_STYLE here so the
 * NO_COLOR contract is preserved repo-wide.
 */
export const TABLE_STYLE = {
  /** Empty arrays = "use no chalk wrappers", giving plain ASCII chars. */
  head: [],
  border: [],
};
