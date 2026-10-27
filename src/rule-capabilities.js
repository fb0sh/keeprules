/**
 * The postInstall vocabulary is a closed set owned by this module.
 *
 * `scope` tells the install policy where a step belongs:
 * - rule: applied once per selected rule
 * - collective: applied once for every selected rule that opts in
 */

export const POST_INSTALL_STEPS = Object.freeze({
  gitignore: Object.freeze({ scope: 'rule' }),
  agents: Object.freeze({ scope: 'collective' }),
});

/** Reject unknown steps at discovery time instead of silently ignoring them. */
export function assertSupportedPostInstall(steps, fileName) {
  for (const step of steps) {
    if (!Object.hasOwn(POST_INSTALL_STEPS, step)) {
      throw new Error(
        `规则 ${fileName} 包含不支持的 postInstall 步骤: "${step}"。支持: ${Object.keys(
          POST_INSTALL_STEPS,
        ).join(', ')}`,
      );
    }
  }
}
